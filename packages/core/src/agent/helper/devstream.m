// capmac devstream: the screen of an iPhone or iPad plugged into this Mac with a cable, as an
// H.264 stream. The picture QuickTime shows for a plugged-in device (CoreMediaIO's iOS screen
// capture), encoded again here so CapMac decides the size, the bitrate and when keyframes come.
//
// The capmac agent compiles it on first use and wraps it in a small app (CapMac.app in
// ~/.capmac/bin/<hash>/) that LaunchServices starts in the background. macOS treats an iOS
// screen as a camera, so the app needs camera access, which macOS asks for once. A program
// started over SSH can neither be asked nor be given it: macOS checks sshd instead.
//
//   devstream --socket <path> --udid <udid> [--name <device name>] [--log <path>]
//             [--max-size 1400] [--fps 60] [--bitrate 6000000] [--debug 1]
//   devstream --list [--wait <seconds>]     the screens it can see, as JSON on stdout
//
// It talks over the Unix socket the agent listens on, with simstream.m's messages and commands
// (see there), so everything after the agent treats both streams alike. Also:
//   out  type 5 still   (payload: a PNG of the newest frame at full size, answering `S`)
//        events  {t:'started', pid}                       first, once connected
//                {t:'wait', for:'device'|'permission'}   waiting for the cable, or for Allow
//                {t:'resume'}                             the device is back after a wait
//                {t:'still-error', message}               no still this time
//   in   S                                                a still
// It takes no input yet: touch, key and button commands get one input-error.
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreMediaIO/CMIOHardware.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <VideoToolbox/VideoToolbox.h>
#import <mach/mach.h>
#import <mach/mach_time.h>
#import <signal.h>
#import <stdatomic.h>
#import <sys/socket.h>
#import <sys/time.h>
#import <sys/un.h>

#define LOG(...) do { fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } while (0)

// ─── Options and state ───────────────────────────────────────────────────────
static int maxSize = 1400, fps = 60, bitrate = 6000000;
static bool debug = false;
static NSString *wantedUdid = @"", *wantedName = @"";
static dispatch_queue_t outQueue, encodeQueue, sessionQueue;
static uint32_t seq = 0;
static atomic_long queuedBytes = 0;
static dispatch_source_t statusTimer, scanTimer, termSource, intSource;

static uint64_t nowUs(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000000ull + (uint64_t)tv.tv_usec;
}

static uint64_t uptimeNs(void) {
  return clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
}

static dispatch_queue_t serialQueue(const char *label) {
  // A fresh autorelease pool per work item keeps memory flat over hours.
  dispatch_queue_attr_t attr = dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM);
  return dispatch_queue_create(label, attr);
}

static void shutdownAndExit(int code);

// ─── Output (as simstream.m) ─────────────────────────────────────────────────
static void writeAll(const void *bytes, size_t length) {
  const uint8_t *p = bytes;
  while (length > 0) {
    ssize_t n = write(STDOUT_FILENO, p, length);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      shutdownAndExit(0); // the agent went away
    }
    p += n;
    length -= (size_t)n;
  }
}

static void emit(uint8_t type, uint8_t flags, uint64_t captureUs, NSData *payload) {
  NSData *copy = [payload copy];
  atomic_fetch_add(&queuedBytes, (long)copy.length);
  dispatch_async(outQueue, ^{
    uint8_t header[4 + 1 + 1 + 2 + 8 + 4];
    uint32_t length = (uint32_t)(sizeof(header) - 4 + copy.length);
    header[0] = length >> 24; header[1] = length >> 16; header[2] = length >> 8; header[3] = length;
    header[4] = type;
    header[5] = flags;
    header[6] = 0; header[7] = 0;
    for (int i = 0; i < 8; i++) header[8 + i] = (uint8_t)(captureUs >> (56 - 8 * i));
    uint32_t s = ++seq;
    header[16] = s >> 24; header[17] = s >> 16; header[18] = s >> 8; header[19] = s;
    writeAll(header, sizeof(header));
    if (copy.length) writeAll(copy.bytes, copy.length);
    atomic_fetch_sub(&queuedBytes, (long)copy.length);
  });
}

static void emitEvent(NSDictionary *event) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (json) emit(4, 0, nowUs(), json);
}

static void fatal(NSString *code, NSString *message, int exitCode) {
  LOG("%s", message.UTF8String);
  emitEvent(@{@"t": @"fatal", @"code": code, @"message": message});
  dispatch_sync(outQueue, ^{});
  shutdownAndExit(exitCode);
}

// ─── Encoder (as simstream.m, with a pixel buffer for a source) ──────────────
static VTCompressionSessionRef session;
static VTPixelTransferSessionRef transfer;
static int32_t sourceWidth = 0, sourceHeight = 0, outWidth = 0, outHeight = 0;
static volatile bool forceKey = true;
static bool configSent = false;
static NSData *lastConfig;
static atomic_long encodedCount = 0, sentCount = 0, droppedCount = 0, encodeErrors = 0;
static atomic_bool awaitingKey = false;
// The byte budget (see simstream.m): 125% of the bitrate, half a second of burst. encodeQueue only.
static double budgetBytes = 0;
static uint64_t budgetAtNs = 0;

static void sendConfig(CMFormatDescriptionRef format) {
  const uint8_t *sps = NULL, *pps = NULL;
  size_t spsLen = 0, ppsLen = 0, count = 0;
  int nalHeader = 0;
  if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, &sps, &spsLen, &count, &nalHeader) != noErr) return;
  if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 1, &pps, &ppsLen, NULL, NULL) != noErr) return;
  if (spsLen < 4) return;
  // AVCDecoderConfigurationRecord (ISO 14496-15): what WebCodecs takes as `description`.
  NSMutableData *avcc = [NSMutableData data];
  uint8_t head[6] = {1, sps[1], sps[2], sps[3], 0xFC | 3, 0xE0 | 1};
  [avcc appendBytes:head length:6];
  uint8_t l[2] = {(uint8_t)(spsLen >> 8), (uint8_t)spsLen};
  [avcc appendBytes:l length:2];
  [avcc appendBytes:sps length:spsLen];
  uint8_t n = 1;
  [avcc appendBytes:&n length:1];
  uint8_t pl[2] = {(uint8_t)(ppsLen >> 8), (uint8_t)ppsLen};
  [avcc appendBytes:pl length:2];
  [avcc appendBytes:pps length:ppsLen];
  if (lastConfig && [lastConfig isEqualToData:avcc]) return;
  lastConfig = avcc;
  NSMutableData *payload = [NSMutableData data];
  uint8_t size[4] = {(uint8_t)(outWidth >> 8), (uint8_t)outWidth, (uint8_t)(outHeight >> 8), (uint8_t)outHeight};
  [payload appendBytes:size length:4];
  [payload appendData:avcc];
  emit(1, 0, nowUs(), payload);
  configSent = true;
}

static void onEncoded(void *ref, void *frameRef, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
  @autoreleasepool {
    if (flags & kVTEncodeInfo_FrameDropped) atomic_fetch_add(&droppedCount, 1);
    if (status != noErr || !sample) {
      if (status != noErr) {
        atomic_fetch_add(&encodeErrors, 1);
        LOG("encode error %d", (int)status);
      }
      return;
    }
    bool key = true;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (attachments && CFArrayGetCount(attachments) > 0) {
      CFDictionaryRef a = CFArrayGetValueAtIndex(attachments, 0);
      key = !CFDictionaryContainsKey(a, kCMSampleAttachmentKey_NotSync);
    }
    if (key) sendConfig(CMSampleBufferGetFormatDescription(sample));
    if (!configSent) return;
    // The agent reads slower than the stream: drop to the next keyframe, and ask for one once
    // the backlog has drained.
    if (key) {
      atomic_store(&awaitingKey, false);
    } else {
      if (atomic_load(&queuedBytes) > 4 * 1024 * 1024) atomic_store(&awaitingKey, true);
      if (atomic_load(&awaitingKey)) {
        atomic_fetch_add(&droppedCount, 1);
        if (atomic_load(&queuedBytes) < 512 * 1024) forceKey = true;
        return;
      }
    }
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    size_t length = 0;
    char *data = NULL;
    if (CMBlockBufferGetDataPointer(block, 0, NULL, &length, &data) != noErr) return;
    uint64_t captureUs = (uint64_t)(uintptr_t)frameRef;
    size_t spent = length;
    dispatch_async(encodeQueue, ^{ budgetBytes -= (double)spent; });
    atomic_fetch_add(&sentCount, 1);
    emit(2, key ? 1 : 0, captureUs, [NSData dataWithBytes:data length:length]);
  }
}

static void teardownEncoder(void) {
  if (!session) return;
  VTCompressionSessionCompleteFrames(session, kCMTimeInvalid);
  VTCompressionSessionInvalidate(session);
  CFRelease(session);
  session = NULL;
}

static bool setupEncoder(void) {
  teardownEncoder();
  if (sourceWidth <= 0 || sourceHeight <= 0) return false;
  double scale = MIN(1.0, (double)maxSize / (double)MAX(sourceWidth, sourceHeight));
  outWidth = ((int32_t)(sourceWidth * scale)) & ~1;
  outHeight = ((int32_t)(sourceHeight * scale)) & ~1;
  NSDictionary *source = @{
    (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
    (__bridge NSString *)kCVPixelBufferWidthKey: @(outWidth),
    (__bridge NSString *)kCVPixelBufferHeightKey: @(outHeight),
    (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  OSStatus st = VTCompressionSessionCreate(NULL, outWidth, outHeight, kCMVideoCodecType_H264, NULL, (__bridge CFDictionaryRef)source, NULL, onEncoded, NULL, &session);
  if (st != noErr) {
    LOG("VTCompressionSessionCreate failed %d", (int)st);
    session = NULL;
    return false;
  }
  VTSessionSetProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
  VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFNumberRef)@(bitrate));
  VTSessionSetProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFNumberRef)@(fps));
  VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, (__bridge CFNumberRef)@(fps * 600));
  VTSessionSetProperty(session, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, (__bridge CFNumberRef)@(600));
  VTCompressionSessionPrepareToEncodeFrames(session);
  lastConfig = nil;
  configSent = false;
  forceKey = true;
  LOG("encoder %dx%d (from %dx%d), %d fps, %d bps", outWidth, outHeight, sourceWidth, sourceHeight, fps, bitrate);
  return true;
}

// ─── Frames (everything below runs on encodeQueue) ──────────────────────────
// The newest picture from the device. Kept after it is encoded: a keyframe asked for while the
// screen is still is made from it.
static CVPixelBufferRef latest;
static bool dirty = false;
static uint64_t dirtyAtUs = 0;
static uint64_t lastEncodeNs = 0;
static bool encodeScheduled = false;
static atomic_long frameCount = 0;
static double transferMs = 0, submitMs = 0;

static double budgetPerSecond(void) {
  return bitrate * 1.25 / 8.0;
}

/** Refills the budget; true when there is some left (a forced keyframe always goes). */
static bool budgetAllows(void) {
  uint64_t now = uptimeNs();
  double rate = budgetPerSecond();
  if (budgetAtNs) budgetBytes = fmin(rate / 2, budgetBytes + rate * (double)(now - budgetAtNs) / 1e9);
  else budgetBytes = rate / 2;
  budgetAtNs = now;
  return budgetBytes >= 0 || forceKey;
}

static void encodeNow(void) {
  if (!latest || !session || (!dirty && !forceKey)) return;
  if (!budgetAllows()) {
    // Over budget: the screen stays dirty and is encoded once the budget recovers.
    if (!encodeScheduled) {
      encodeScheduled = true;
      double wait = -budgetBytes / budgetPerSecond();
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(fmax(wait, 0.004) * 1e9)), encodeQueue, ^{
        encodeScheduled = false;
        encodeNow();
      });
    }
    return;
  }
  uint64_t captureUs = dirtyAtUs ? dirtyAtUs : nowUs();
  dirty = false;
  dirtyAtUs = 0;
  lastEncodeNs = uptimeNs();
  uint64_t t0 = mach_absolute_time();
  CVPixelBufferRef frame = NULL;
  bool sameSize = (int32_t)CVPixelBufferGetWidth(latest) == outWidth && (int32_t)CVPixelBufferGetHeight(latest) == outHeight;
  if (sameSize && CVPixelBufferGetPixelFormatType(latest) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) {
    // The device's own size: no copy, the encoder takes the capture buffer as it is.
    frame = CVPixelBufferRetain(latest);
  } else {
    CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(session);
    if (!pool || CVPixelBufferPoolCreatePixelBuffer(NULL, pool, &frame) != kCVReturnSuccess) {
      // The session went bad (a GPU reset, the Mac waking up): start a fresh one.
      if (!pool) setupEncoder();
      return;
    }
    if (!transfer) VTPixelTransferSessionCreate(NULL, &transfer);
    OSStatus st = VTPixelTransferSessionTransferImage(transfer, latest, frame);
    if (st != noErr) {
      LOG("transfer failed %d", (int)st);
      CVPixelBufferRelease(frame);
      return;
    }
  }
  uint64_t t1 = mach_absolute_time();
  NSDictionary *props = nil;
  if (forceKey) {
    props = @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES};
    forceKey = false;
  }
  CMTime pts = CMTimeMake((int64_t)(mach_absolute_time() / 1000), 1000000);
  OSStatus st = VTCompressionSessionEncodeFrame(session, frame, pts, kCMTimeInvalid, (__bridge CFDictionaryRef)props, (void *)(uintptr_t)captureUs, NULL);
  uint64_t t2 = mach_absolute_time();
  CVPixelBufferRelease(frame);
  if (st != noErr) {
    LOG("encode failed %d, restarting the encoder", (int)st);
    atomic_fetch_add(&encodeErrors, 1);
    setupEncoder();
    return;
  }
  static mach_timebase_info_data_t tb;
  if (!tb.denom) mach_timebase_info(&tb);
  transferMs += (double)(t1 - t0) * tb.numer / tb.denom / 1e6;
  submitMs += (double)(t2 - t1) * tb.numer / tb.denom / 1e6;
  atomic_fetch_add(&encodedCount, 1);
}

// Encodes right away when the last frame is old enough, else at the next slot (at most `fps` a second).
static void encodeSoon(void) {
  if (encodeScheduled) return;
  uint64_t minInterval = (uint64_t)(1e9 / fps * 0.8);
  uint64_t now = uptimeNs();
  if (now >= lastEncodeNs + minInterval) {
    encodeNow();
    return;
  }
  encodeScheduled = true;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(lastEncodeNs + minInterval - now)), encodeQueue, ^{
    encodeScheduled = false;
    encodeNow();
  });
}

/** A new picture from the device, captured at `captureUs` (the Mac's clock). */
static void newFrame(CVPixelBufferRef buffer, uint64_t captureUs) {
  atomic_fetch_add(&frameCount, 1);
  int32_t w = (int32_t)CVPixelBufferGetWidth(buffer), h = (int32_t)CVPixelBufferGetHeight(buffer);
  CVPixelBufferRetain(buffer);
  if (latest) CVPixelBufferRelease(latest);
  latest = buffer;
  // A new size (the device turned, or the capture renegotiated): a new encoder, a new config.
  if (w != sourceWidth || h != sourceHeight || !session) {
    sourceWidth = w;
    sourceHeight = h;
    if (!setupEncoder()) fatal(@"ENCODER", @"The video encoder could not start.", 7);
  }
  if (!dirty) dirtyAtUs = captureUs;
  dirty = true;
  encodeSoon();
}

/** A PNG of the newest picture at the device's size. */
static void sendStill(void) {
  if (!latest) {
    emitEvent(@{@"t": @"still-error", @"message": @"There is no picture yet."});
    return;
  }
  CGImageRef image = NULL;
  OSStatus st = VTCreateCGImageFromCVPixelBuffer(latest, NULL, &image);
  if (st != noErr || !image) {
    emitEvent(@{@"t": @"still-error", @"message": [NSString stringWithFormat:@"The picture could not be converted (%d).", (int)st]});
    return;
  }
  NSMutableData *png = [NSMutableData data];
  CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, CFSTR("public.png"), 1, NULL);
  bool ok = false;
  if (dest) {
    CGImageDestinationAddImage(dest, image, NULL);
    ok = CGImageDestinationFinalize(dest);
    CFRelease(dest);
  }
  CGImageRelease(image);
  if (!ok) {
    emitEvent(@{@"t": @"still-error", @"message": @"The picture could not be saved as PNG."});
    return;
  }
  emit(5, 0, nowUs(), png);
}

// ─── The device ──────────────────────────────────────────────────────────────
@interface Grabber : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@end

static AVCaptureSession *captureSession;
static AVCaptureDevice *captureDevice;
static Grabber *grabber;
static id connectObserver, disconnectObserver, errorObserver;
static bool helloSent = false, waitingForDevice = false, askingPermission = false;
static uint64_t startedNs = 0;
static int restarts = 0;

@implementation Grabber
- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)sample fromConnection:(AVCaptureConnection *)connection {
  CVImageBufferRef image = CMSampleBufferGetImageBuffer(sample);
  if (!image) return;
  // When the device drew it, on the Mac's clock: the capture timestamp is host time.
  uint64_t captureUs = nowUs();
  CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
  if (CMTIME_IS_NUMERIC(pts)) {
    double age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts));
    if (age >= 0 && age < 1.0) captureUs -= (uint64_t)(age * 1e6);
  }
  newFrame(image, captureUs);
}

- (void)captureOutput:(AVCaptureOutput *)output didDropSampleBuffer:(CMSampleBufferRef)sample fromConnection:(AVCaptureConnection *)connection {
  atomic_fetch_add(&droppedCount, 1);
}
@end

static NSString *normalized(NSString *s) {
  return [[s stringByReplacingOccurrencesOfString:@"-" withString:@""] lowercaseString];
}

// The screens of plugged-in iPhones and iPads: muxed (picture and sound) external devices.
// The same iPhone also shows up nearby as a Continuity Camera, which is video only: never that.
static NSArray<AVCaptureDevice *> *screenDevices(void) {
  NSArray *types;
  if (@available(macOS 14.0, *)) {
    types = @[AVCaptureDeviceTypeExternal];
  } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    types = @[AVCaptureDeviceTypeExternalUnknown];
#pragma clang diagnostic pop
  }
  NSMutableArray *found = [NSMutableArray array];
  AVCaptureDeviceDiscoverySession *discovery = [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:types mediaType:AVMediaTypeMuxed position:AVCaptureDevicePositionUnspecified];
  for (AVCaptureDevice *d in discovery.devices) {
    if ([d hasMediaType:AVMediaTypeMuxed]) [found addObject:d];
  }
  return found;
}

static NSDictionary *describe(AVCaptureDevice *d) {
  CMVideoDimensions size = {0, 0};
  if (d.activeFormat) size = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription);
  return @{@"uniqueID": d.uniqueID ?: @"", @"name": d.localizedName ?: @"", @"model": d.modelID ?: @"", @"width": @(size.width), @"height": @(size.height)};
}

static AVCaptureDevice *wantedScreen(void) {
  NSArray<AVCaptureDevice *> *devices = screenDevices();
  NSString *want = normalized(wantedUdid);
  if (want.length) {
    for (AVCaptureDevice *d in devices) {
      if ([normalized(d.uniqueID) isEqualToString:want]) return d;
    }
  }
  if (wantedName.length) {
    for (AVCaptureDevice *d in devices) {
      if ([d.localizedName isEqualToString:wantedName]) return d;
    }
  }
  if (debug && devices.count) {
    for (AVCaptureDevice *d in devices) LOG("not this one: %s", [describe(d) description].UTF8String);
  }
  return nil;
}

static void enableScreenCapture(bool wireless) {
  // Off by default in every process: without it CoreMediaIO lists no iOS screens at all.
  CMIOObjectPropertyAddress wired = {kCMIOHardwarePropertyAllowScreenCaptureDevices, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
  UInt32 yes = 1;
  OSStatus st = CMIOObjectSetPropertyData(kCMIOObjectSystemObject, &wired, 0, NULL, sizeof yes, &yes);
  if (st != noErr) LOG("allowing screen capture devices failed: %d", (int)st);
  if (wireless) {
    CMIOObjectPropertyAddress air = {kCMIOHardwarePropertyAllowWirelessScreenCaptureDevices, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
    st = CMIOObjectSetPropertyData(kCMIOObjectSystemObject, &air, 0, NULL, sizeof yes, &yes);
    if (st != noErr) LOG("allowing wireless screen capture devices failed: %d", (int)st);
  }
}

static void lookForDevice(void);

static void stopCapture(void) {
  AVCaptureSession *s = captureSession;
  captureSession = nil;
  captureDevice = nil;
  if (s) dispatch_sync(sessionQueue, ^{ [s stopRunning]; });
}

static void sendHello(AVCaptureDevice *device) {
  CMVideoDimensions size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription);
  // iPhones and iPads draw at 2 or 3 pixels a point; the capture keeps the device's own pixels.
  double longest = MAX(size.width, size.height), shortest = MIN(size.width, size.height);
  double scale = longest / shortest < 1.6 ? 2 : shortest >= 1000 ? 3 : 2;
  NSMutableDictionary *hello = [@{
    @"t": @"hello",
    @"device": device.localizedName ?: @"",
    @"model": device.modelID ?: @"",
    @"video": @YES,
    @"api": @"CoreMediaIO",
    @"input": @NO,
    @"inputReason": @"Touch and typing work on simulators. On a real iPhone, use the iPhone itself for now.",
    @"coreSimulator": @"",
    @"pid": @(getpid()),
  } mutableCopy];
  if (size.width > 0 && size.height > 0) {
    hello[@"scale"] = @(scale);
    hello[@"pixels"] = @{@"width": @(size.width), @"height": @(size.height)};
    hello[@"points"] = @{@"width": @(round(size.width / scale)), @"height": @(round(size.height / scale))};
  }
  emitEvent(hello);
  helloSent = true;
}

static void startCapture(AVCaptureDevice *device) {
  NSError *error = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
  if (!input) {
    fatal(@"CAPTURE_FAILED", [NSString stringWithFormat:@"%@ did not share its screen: %@", device.localizedName, error.localizedDescription ?: @"unknown error"], 9);
    return;
  }
  // Picture only: the device's sound keeps playing on the device.
  for (AVCaptureInputPort *port in input.ports) {
    if (![port.mediaType isEqualToString:AVMediaTypeVideo]) port.enabled = NO;
  }
  AVCaptureSession *s = [AVCaptureSession new];
  if (![s canAddInput:input]) {
    fatal(@"CAPTURE_FAILED", [NSString stringWithFormat:@"%@'s screen is in use by another app.", device.localizedName], 9);
    return;
  }
  [s addInput:input];
  AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
  output.alwaysDiscardsLateVideoFrames = YES;
  output.videoSettings = @{
    (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
    (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  [output setSampleBufferDelegate:grabber queue:encodeQueue];
  if (![s canAddOutput:output]) {
    fatal(@"CAPTURE_FAILED", @"The screen capture could not be set up.", 9);
    return;
  }
  [s addOutput:output];
  captureSession = s;
  captureDevice = device;
  if (errorObserver) [[NSNotificationCenter defaultCenter] removeObserver:errorObserver];
  errorObserver = [[NSNotificationCenter defaultCenter] addObserverForName:AVCaptureSessionRuntimeErrorNotification object:s queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
    NSError *e = note.userInfo[AVCaptureSessionErrorKey];
    LOG("capture error: %s", e.localizedDescription.UTF8String ?: "unknown");
    if (captureSession != s) return;
    // A few more tries, then give up: a device that keeps failing needs a fresh start.
    if (++restarts > 3) {
      fatal(@"CAPTURE_FAILED", [NSString stringWithFormat:@"The screen capture failed: %@", e.localizedDescription ?: @"unknown error"], 9);
      return;
    }
    dispatch_async(sessionQueue, ^{ [s startRunning]; });
  }];
  // Before the first frame: the agent learns the device and its size first.
  if (!helloSent) sendHello(device);
  else emitEvent(@{@"t": @"resume"});
  dispatch_async(sessionQueue, ^{
    [s startRunning];
    LOG("capturing %s (%s), %d ms after start", device.localizedName.UTF8String, device.uniqueID.UTF8String, (int)((uptimeNs() - startedNs) / 1000000));
    dispatch_async(encodeQueue, ^{
      forceKey = true;
      dirty = latest != NULL;
      encodeSoon();
    });
  });
}

/** True when the app may capture; else asks macOS once (the answer looks for the device again). */
static bool permissionGranted(void) {
  AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if (status == AVAuthorizationStatusAuthorized) return true;
  if (status == AVAuthorizationStatusNotDetermined) {
    if (askingPermission) return false;
    askingPermission = true;
    emitEvent(@{@"t": @"wait", @"for": @"permission"});
    LOG("asking for camera access");
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        askingPermission = false;
        LOG("camera access %s", granted ? "allowed" : "not allowed");
        if (granted) lookForDevice();
        else fatal(@"NO_PERMISSION", @"CapMac was not allowed to see the iPhone's screen.", 8);
      });
    }];
    return false;
  }
  fatal(@"NO_PERMISSION", @"CapMac is not allowed to see the iPhone's screen.", 8);
  return false;
}

static void lookForDevice(void) {
  if (captureSession) return;
  AVCaptureDevice *device = wantedScreen();
  if (!device) {
    // CoreMediaIO takes a moment to list a device that was already plugged in.
    if (!waitingForDevice && uptimeNs() - startedNs > 2500 * NSEC_PER_MSEC) {
      waitingForDevice = true;
      emitEvent(@{@"t": @"wait", @"for": @"device"});
      LOG("waiting for %s to be plugged in", (wantedName.length ? wantedName : wantedUdid).UTF8String);
    }
    return;
  }
  // Asked only once the device is there: the question makes sense to whoever sees it then.
  if (!permissionGranted()) return;
  waitingForDevice = false;
  startCapture(device);
}

// ─── Commands ────────────────────────────────────────────────────────────────
static void handleCommand(char *line) {
  char *nl = strpbrk(line, "\r\n");
  if (nl) *nl = 0;
  char cmd = line[0];
  if (!cmd) return;
  if (cmd == 'k') {
    dispatch_async(encodeQueue, ^{
      forceKey = true;
      dirty = true;
      encodeSoon();
    });
  } else if (cmd == 'p') {
    uint64_t echo = strtoull(line + 1, NULL, 10);
    uint8_t b[8];
    for (int i = 0; i < 8; i++) b[i] = (uint8_t)(echo >> (56 - 8 * i));
    emit(3, 0, nowUs(), [NSData dataWithBytes:b length:8]);
  } else if (cmd == 's') {
    int size = atoi(line + 1);
    if (size < 320 || size > 4096) return;
    dispatch_async(encodeQueue, ^{
      if (size == maxSize) return;
      maxSize = size;
      if (latest && setupEncoder()) {
        dirty = true;
        encodeSoon();
      }
    });
  } else if (cmd == 'r') {
    long value = strtol(line + 1, NULL, 10);
    if (value < 200000 || value > 20000000) return;
    dispatch_async(encodeQueue, ^{
      if ((int)value == bitrate) return;
      bitrate = (int)value;
      if (session) VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFNumberRef)@(bitrate));
      if (budgetBytes > budgetPerSecond() / 2) budgetBytes = budgetPerSecond() / 2;
      LOG("bitrate %d bps", bitrate);
    });
  } else if (cmd == 'S') {
    dispatch_async(encodeQueue, ^{ sendStill(); });
  } else if (cmd == 'q') {
    shutdownAndExit(0);
  } else if (strchr("tTcwbK", cmd)) {
    static bool told = false;
    if (!told) emitEvent(@{@"t": @"input-error", @"message": @"A real iPhone takes no input from CapMac yet."});
    told = true;
  }
}

// ─── Lifetime ────────────────────────────────────────────────────────────────
static void shutdownAndExit(int code) {
  static atomic_bool exiting = false;
  if (atomic_exchange(&exiting, true)) {
    for (;;) pause();
  }
  // Stop the capture cleanly: the device leaves screen sharing, and the Mac's camera light goes off.
  AVCaptureSession *s = captureSession;
  if (s && sessionQueue) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(sessionQueue, ^{
      [s stopRunning];
      dispatch_semaphore_signal(done);
    });
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 1500 * NSEC_PER_MSEC));
  }
  exit(code);
}

static long footprintBytes(void) {
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return 0;
  return (long)info.phys_footprint;
}

static void statusTick(void) {
  static long lastFrames = 0, lastEncoded = 0, lastSent = 0, lastDropped = 0;
  long frames = atomic_load(&frameCount), encoded = atomic_load(&encodedCount), sent = atomic_load(&sentCount), dropped = atomic_load(&droppedCount);
  long n = encoded - lastEncoded;
  emitEvent(@{
    @"t": @"status",
    @"callbacks": @(frames - lastFrames),
    @"encoded": @(n),
    @"sent": @(sent - lastSent),
    @"dropped": @(dropped - lastDropped),
    @"seed": @0,
    @"footprint": @(footprintBytes()),
    @"queued": @(atomic_load(&queuedBytes)),
    @"width": @(outWidth),
    @"height": @(outHeight),
  });
  if (debug) LOG("debug: frames/s=%ld encoded/s=%ld sent/s=%ld dropped/s=%ld transfer=%.2fms submit=%.2fms footprint=%.1fMB", frames - lastFrames, n, sent - lastSent, dropped - lastDropped, n ? transferMs / n : 0, n ? submitMs / n : 0, footprintBytes() / 1048576.0);
  lastFrames = frames;
  lastEncoded = encoded;
  lastSent = sent;
  lastDropped = dropped;
  transferMs = 0;
  submitMs = 0;
  if (atomic_load(&awaitingKey) && atomic_load(&queuedBytes) < 512 * 1024) {
    forceKey = true;
    encodeSoon();
  }
}

static void connectTo(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  if (fd < 0 || strlen(path) >= sizeof addr.sun_path) {
    LOG("bad socket path %s", path);
    exit(3);
  }
  strncpy(addr.sun_path, path, sizeof addr.sun_path - 1);
  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
    LOG("connecting to %s failed: %s", path, strerror(errno));
    exit(3);
  }
  // Frames are tens of kilobytes; the default 8 KB buffer would make every write wait for the agent.
  int buffer = 1024 * 1024;
  setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &buffer, sizeof buffer);
  setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &buffer, sizeof buffer);
  dup2(fd, STDIN_FILENO);
  dup2(fd, STDOUT_FILENO);
  close(fd);
}

static int listScreens(double wait, bool wireless) {
  enableScreenCapture(wireless);
  [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:wait]];
  NSMutableArray *list = [NSMutableArray array];
  for (AVCaptureDevice *d in screenDevices()) [list addObject:describe(d)];
  NSDictionary *out = @{@"screens": list, @"permission": @([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo])};
  NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    const char *socketPath = NULL, *logPath = NULL;
    bool list = false, wireless = false;
    double wait = 2.5;
    for (int i = 1; i < argc; i++) {
      const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
      if (!strcmp(a, "--list")) list = true;
      else if (!strcmp(a, "--wireless")) wireless = true;
      else if (!v) break;
      else if (!strcmp(a, "--socket")) socketPath = v, i++;
      else if (!strcmp(a, "--log")) logPath = v, i++;
      else if (!strcmp(a, "--udid")) wantedUdid = [NSString stringWithUTF8String:v], i++;
      else if (!strcmp(a, "--name")) wantedName = [NSString stringWithUTF8String:v], i++;
      else if (!strcmp(a, "--wait")) wait = atof(v), i++;
      else if (!strcmp(a, "--max-size")) maxSize = MAX(320, MIN(4096, atoi(v))), i++;
      else if (!strcmp(a, "--fps")) fps = MAX(1, MIN(120, atoi(v))), i++;
      else if (!strcmp(a, "--bitrate")) bitrate = MAX(250000, MIN(50000000, atoi(v))), i++;
      else if (!strcmp(a, "--debug")) debug = atoi(v) != 0, i++;
      // LaunchServices may add arguments of its own (-psn_…): ignore what is not ours.
    }
    if (list) return listScreens(wait, wireless);
    if (logPath) freopen(logPath, "a", stderr);
    if (!socketPath) {
      LOG("usage: devstream --socket <path> --udid <udid> [--name <name>] [--log <path>] [--max-size N] [--fps N] [--bitrate N] | --list [--wait S]");
      return 2;
    }
    connectTo(socketPath);
    startedNs = uptimeNs();
    outQueue = serialQueue("capmac.out");
    encodeQueue = serialQueue("capmac.encode");
    sessionQueue = serialQueue("capmac.session");
    grabber = [Grabber new];
    LOG("devstream %d for %s (%s)", getpid(), wantedName.UTF8String, wantedUdid.UTF8String);
    // The agent did not start this process itself: it learns the pid here.
    emitEvent(@{@"t": @"started", @"pid": @(getpid())});

    enableScreenCapture(wireless);
    connectObserver = [[NSNotificationCenter defaultCenter] addObserverForName:AVCaptureDeviceWasConnectedNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
      lookForDevice();
    }];
    disconnectObserver = [[NSNotificationCenter defaultCenter] addObserverForName:AVCaptureDeviceWasDisconnectedNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
      if (!captureDevice || note.object != captureDevice) return;
      LOG("%s was unplugged", captureDevice.localizedName.UTF8String);
      stopCapture();
      waitingForDevice = true;
      emitEvent(@{@"t": @"wait", @"for": @"device"});
    }];
    // Notifications can come before CoreMediaIO lists the device: look again now and then.
    scanTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(scanTimer, DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC, 100 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(scanTimer, ^{ lookForDevice(); });
    dispatch_resume(scanTimer);

    statusTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, encodeQueue);
    dispatch_source_set_timer(statusTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, 50 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(statusTimer, ^{
      if (helloSent) statusTick();
    });
    dispatch_resume(statusTimer);

    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    termSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    dispatch_source_set_event_handler(termSource, ^{ shutdownAndExit(0); });
    dispatch_resume(termSource);
    intSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    dispatch_source_set_event_handler(intSource, ^{ shutdownAndExit(0); });
    dispatch_resume(intSource);

    // Commands from the agent; when the socket closes, the agent is gone and so are we.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
      char line[512];
      while (fgets(line, sizeof line, stdin)) {
        @autoreleasepool {
          handleCommand(line);
        }
      }
      shutdownAndExit(0);
    });
    // CoreMediaIO and AVFoundation deliver device notifications through the main run loop.
    CFRunLoopRun();
  }
  return 0;
}
