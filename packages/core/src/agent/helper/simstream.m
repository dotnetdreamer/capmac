// capmac simstream: the iOS simulator's screen as an H.264 stream, plus touch, keyboard and
// hardware-button input. The capmac agent compiles it on the Mac with the installed Xcode
// (xcrun clang) on first use and caches it in ~/.capmac/bin/<hash>/. It relies on private
// CoreSimulator and SimulatorKit interfaces, so it detects what is there at runtime and says
// what is missing instead of guessing.
//
//   simstream <udid> [--developer-dir <dir>] [--max-size 1400] [--fps 60] [--bitrate 6000000]
//                    [--video 0|1] [--input 0|1] [--debug 1]
//
// Capture: the device's own screen (Xcode 26: SimScreen frame callbacks and its framebuffer
// IOSurface; before: SimDisplayRenderable damage callbacks). Frames are produced only when the
// screen changes, so an idle simulator costs nothing.
// Encode: VideoToolbox H.264 High, real-time, no frame reordering, standard rate control,
// keyframes only on request.
// Input: SimulatorKit's SimDeviceLegacyHIDClient with Indigo HID messages, built the way idb does
// (FBSimulatorControl, MIT licence): touches, hardware buttons and keyboard usages.
//
// stdout, one message each:  u32 length (big endian, of everything after it)
//   u8  type   1 config  (payload: u16 width, u16 height, avcC record)
//              2 frame   (payload: AVCC length-prefixed NAL units)
//              3 pong    (payload: u64 echo, the value from the ping)
//              4 event   (payload: a UTF-8 JSON object: hello, status, input-error, fatal)
//   u8  flags  bit 0: keyframe
//   u16 reserved
//   u64 capture time, Unix epoch microseconds on the Mac's clock
//   u32 sequence number
//   payload
//
// stdin, one command per line; the end of stdin quits (lifting any finger still down):
//   k                             keyframe now
//   s <pixels>                    longest side of the video
//   r <bits per second>           average bitrate (adaptive bitrate; the byte budget follows)
//   p <number>                    pong with that number
//   q                             quit
//   t d|m|u <x> <y>               one finger down, move, up; x and y from 0 to 1, top left origin
//   T d|m|u <x1> <y1> <x2> <y2>   two fingers
//   c                             lift any finger still down
//   w <x> <y> <dx> <dy>           scroll at (x, y) by (dx, dy) points, as a short finger drag
//   b home|lock|side|siri|applepay d|u    hardware button
//   K <usage> d|u                 keyboard key, a USB HID usage (page 7)
// stderr: log lines (with --debug 1, a line a second with the counters).
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>
#import <dlfcn.h>
#import <mach/mach.h>
#import <mach/mach_time.h>
#import <malloc/malloc.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <signal.h>
#import <stdatomic.h>
#import <sys/time.h>

#define LOG(...) do { fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } while (0)

// ─── Private API shapes ──────────────────────────────────────────────────────
@protocol CMSimServiceContext
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
@end
@protocol CMSimDeviceSet
- (NSArray *)devices;
@end
@protocol CMSimDevice
- (NSUUID *)UDID;
- (NSString *)name;
- (id)io;
- (id)deviceType;
- (unsigned long long)state;
@end
@protocol CMSimDeviceType
- (CGSize)mainScreenSize;
- (float)mainScreenScale;
@end
@protocol CMSimDeviceIO
- (NSArray *)ioPorts;
@end
@protocol CMSimPort
- (id)descriptor;
@end
@protocol CMSimDisplay
- (unsigned short)displayClass;
- (id)framebufferSurface;
- (void)registerCallbackWithUUID:(NSUUID *)uuid ioSurfacesChangeCallback:(void (^)(id, id))cb;
- (void)registerCallbackWithUUID:(NSUUID *)uuid damageRectanglesCallback:(void (^)(NSArray *))cb;
- (void)unregisterIOSurfacesChangeCallbackWithUUID:(NSUUID *)uuid;
- (void)unregisterDamageRectanglesCallbackWithUUID:(NSUUID *)uuid;
// Xcode 26 (SimScreen): a tick per rendered frame, on our queue.
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid callbackQueue:(dispatch_queue_t)queue frameCallback:(void (^)(void))frame surfacesChangedCallback:(void (^)(id, id))surfaces propertiesChangedCallback:(void (^)(id))properties;
- (void)unregisterScreenCallbacksWithUUID:(NSUUID *)uuid;
- (id)screenProperties;
@end
@protocol CMLegacyHIDClient
- (id)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)freeWhenDone completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
@end

// Indigo HID wire format (from idb's PrivateHeaders/SimulatorApp/Indigo.h, MIT; Xcode 26).
#pragma pack(push, 4)
typedef struct {
  unsigned int field1, field2, eventMask;
  double xRatio, yRatio, field6, field7, field8;
  unsigned int range, touch, field11, field12, field13;
  double field14, field15, field16, field17, field18;
} IndigoTouch;
typedef union {
  IndigoTouch touch;
  unsigned char raw[0x80];
} IndigoEvent;
typedef struct {
  unsigned int eventKind;
  unsigned long long timestamp;
  unsigned int field3;
  IndigoEvent event;
} IndigoPayload;
typedef struct {
  mach_msg_header_t header;
  unsigned int innerSize;
  unsigned char eventType;
  IndigoPayload payload;
} IndigoMessage;
#pragma pack(pop)
_Static_assert(sizeof(IndigoTouch) == 0x70, "IndigoTouch layout");
_Static_assert(sizeof(IndigoPayload) == 0x90, "IndigoPayload layout");
_Static_assert(sizeof(IndigoMessage) == 0xB0, "IndigoMessage layout");

typedef IndigoMessage *(*IndigoMouseFn)(CGPoint *, CGPoint *, uint32_t target, unsigned long eventType, CGSize size, uint32_t edge);
typedef IndigoMessage *(*IndigoButtonFn)(int32_t source, int32_t direction, int32_t target);
typedef IndigoMessage *(*IndigoKeyboardFn)(int32_t usage, int32_t direction);
typedef IndigoMessage *(*IndigoHIDArbitraryFn)(int32_t target, uint32_t page, uint32_t usage, int32_t direction);

enum { DirectionDown = 1, DirectionUp = 2 };
enum { EdgeNone = 0, EdgeTop = 1, EdgeLeft = 2, EdgeBottom = 3, EdgeRight = 4 };
static const uint32_t TargetDigitizer = 0x32;
static const int32_t TargetHardware = 0x33;

// ─── Options and state ───────────────────────────────────────────────────────
static int maxSize = 1400, fps = 60, bitrate = 6000000;
static bool debug = false, wantVideo = true, wantInput = true;
static dispatch_queue_t outQueue, encodeQueue, hidQueue;
static uint32_t seq = 0;
static atomic_long queuedBytes = 0;
// Held for the life of the process: under ARC a timer nobody references is released and stops.
static dispatch_source_t statusTimer, wheelTimer, termSource, intSource;

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

// ─── Output ──────────────────────────────────────────────────────────────────
static void writeAll(const void *bytes, size_t length) {
  const uint8_t *p = bytes;
  while (length > 0) {
    ssize_t n = write(STDOUT_FILENO, p, length);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      shutdownAndExit(0); // the reader went away
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
  exit(exitCode);
}

// ─── Encoder ─────────────────────────────────────────────────────────────────
static VTCompressionSessionRef session;
static VTPixelTransferSessionRef transfer;
static int32_t sourceWidth = 0, sourceHeight = 0, outWidth = 0, outHeight = 0;
static volatile bool forceKey = true;
static bool configSent = false;
static NSData *lastConfig;
static atomic_long encodedCount = 0, sentCount = 0, droppedCount = 0, encodeErrors = 0;
// Set when frames had to be dropped because stdout backed up: resume at the next keyframe.
static atomic_bool awaitingKey = false;
// The average bitrate is only a target: the hardware encoder overshoots it several times over
// on incompressible content (noise, video) and ignores DataRateLimits and frame QP limits in
// real time. So the helper keeps its own budget, 125% of the bitrate (a token bucket that
// allows half a second of burst, enough for a keyframe), and encodes fewer frames when it runs
// out. encodeQueue only.
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
    // stdout backed up (the reader is slower than the stream): drop to the next keyframe,
    // and ask for one once the backlog has drained.
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

// ─── Capture (everything below runs on encodeQueue) ─────────────────────────
static id<CMSimDisplay> display;
static IOSurfaceRef surface;
static bool dirty = true;
static uint64_t dirtyAtUs = 0;
static uint64_t lastEncodeNs = 0;
static bool encodeScheduled = false;
static atomic_long callbackCount = 0;
static uint64_t lastCallbackNs = 0;
static double transferMs = 0, submitMs = 0;

static void setSurface(id s) {
  if (surface) CFRelease(surface);
  surface = s ? (IOSurfaceRef)CFRetain((__bridge CFTypeRef)s) : NULL;
  if (!surface) return;
  int32_t w = (int32_t)IOSurfaceGetWidth(surface), h = (int32_t)IOSurfaceGetHeight(surface);
  if (w != sourceWidth || h != sourceHeight || !session) {
    sourceWidth = w;
    sourceHeight = h;
    if (!setupEncoder()) fatal(@"ENCODER", @"The video encoder could not start.", 7);
  }
  forceKey = true;
  dirty = true;
  dirtyAtUs = nowUs();
}

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
  if (!surface || !session || (!dirty && !forceKey)) return;
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
  CVPixelBufferRef src = NULL;
  if (CVPixelBufferCreateWithIOSurface(NULL, surface, NULL, &src) != kCVReturnSuccess) return;
  CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(session);
  CVPixelBufferRef dst = NULL;
  if (!pool || CVPixelBufferPoolCreatePixelBuffer(NULL, pool, &dst) != kCVReturnSuccess) {
    CVPixelBufferRelease(src);
    // The session went bad (a GPU reset, the Mac waking up): start a fresh one.
    if (!pool) setupEncoder();
    return;
  }
  if (!transfer) VTPixelTransferSessionCreate(NULL, &transfer);
  uint64_t t0 = mach_absolute_time();
  OSStatus st = VTPixelTransferSessionTransferImage(transfer, src, dst);
  uint64_t t1 = mach_absolute_time();
  CVPixelBufferRelease(src);
  if (st != noErr) {
    LOG("transfer failed %d", (int)st);
    CVPixelBufferRelease(dst);
    return;
  }
  NSDictionary *props = nil;
  if (forceKey) {
    props = @{(__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES};
    forceKey = false;
  }
  CMTime pts = CMTimeMake((int64_t)(mach_absolute_time() / 1000), 1000000);
  st = VTCompressionSessionEncodeFrame(session, dst, pts, kCMTimeInvalid, (__bridge CFDictionaryRef)props, (void *)(uintptr_t)captureUs, NULL);
  uint64_t t2 = mach_absolute_time();
  CVPixelBufferRelease(dst);
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

static void markDirty(void) {
  atomic_fetch_add(&callbackCount, 1);
  lastCallbackNs = uptimeNs();
  if (!dirty) dirtyAtUs = nowUs();
  dirty = true;
  encodeSoon();
}

// ─── Input ───────────────────────────────────────────────────────────────────
static id<CMLegacyHIDClient> hidClient;
static IndigoMouseFn mouseFn;
static IndigoButtonFn buttonFn;
static IndigoKeyboardFn keyboardFn;
static IndigoHIDArbitraryFn hidArbitraryFn;
static NSString *inputUnavailable;
static double pointsWidth = 0, pointsHeight = 0;
// One finger (pointer drags) and the virtual finger that turns wheel scrolling into drags. hidQueue only.
static bool fingerDown = false, twoDown = false;
static uint32_t fingerEdge = EdgeNone;
static double fingerX = 0, fingerY = 0, twoX1 = 0, twoY1 = 0, twoX2 = 0, twoY2 = 0;
static uint64_t fingerMovedNs = 0;
// Whether this touch travelled (a drag) rather than staying put (a tap or a long press).
static bool fingerDragged = false;
static double fingerStartX = 0, fingerStartY = 0;
static bool wheelDown = false;
static double wheelX = 0, wheelY = 0;
static uint64_t wheelLastNs = 0;
static atomic_long inputErrors = 0;

static double clamp01(double v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

static void hidSend(IndigoMessage *message) {
  if (!message) return;
  @try {
    [hidClient sendWithMessage:message freeWhenDone:YES completionQueue:hidQueue completion:^(NSError *error) {
      if (!error) return;
      if (atomic_fetch_add(&inputErrors, 1) < 5) emitEvent(@{@"t": @"input-error", @"message": error.localizedDescription ?: @"unknown error"});
    }];
  } @catch (NSException *e) {
    if (atomic_fetch_add(&inputErrors, 1) < 5) emitEvent(@{@"t": @"input-error", @"message": e.reason ?: e.name});
  }
}

// One finger, as a single-touch message: idb's recipe. SimulatorKit only builds multi-touch
// messages, so take its digitizer contact and wrap it as a two-payload single-touch message.
static void sendTouch(double x, double y, int direction, uint32_t edge) {
  CGPoint point = CGPointMake(clamp01(x), clamp01(y));
  IndigoMessage *source = mouseFn(&point, NULL, TargetDigitizer, (unsigned long)direction, CGSizeMake(1, 1), edge);
  if (!source) return;
  source->payload.event.touch.xRatio = point.x;
  source->payload.event.touch.yRatio = point.y;
  size_t size = sizeof(IndigoMessage) + sizeof(IndigoPayload);
  IndigoMessage *message = calloc(1, size);
  message->innerSize = sizeof(IndigoPayload);
  message->eventType = 2; // single touch
  message->payload.eventKind = 0xB;
  message->payload.timestamp = mach_absolute_time();
  memcpy((uint8_t *)message + 0x30, (uint8_t *)source + 0x30, sizeof(IndigoTouch));
  free(source);
  IndigoPayload *second = (IndigoPayload *)((uint8_t *)message + 0x20 + sizeof(IndigoPayload));
  memcpy(second, &message->payload, sizeof(IndigoPayload));
  second->event.touch.field1 = 1;
  second->event.touch.field2 = 2;
  hidSend(message);
}

static void sendTwoFingers(double x1, double y1, double x2, double y2, int direction) {
  CGPoint a = CGPointMake(clamp01(x1), clamp01(y1)), b = CGPointMake(clamp01(x2), clamp01(y2));
  IndigoMessage *message = mouseFn(&a, &b, TargetDigitizer, (unsigned long)direction, CGSizeMake(1, 1), EdgeNone);
  if (!message) return;
  // Multi-payload messages are laid out at a 0xA0 stride: the digitizer summary at 0xC0 mirrors
  // the first finger, the second finger is at 0x160.
  size_t size = malloc_size(message);
  message->payload.event.touch.xRatio = a.x;
  message->payload.event.touch.yRatio = a.y;
  if (size >= 0xC0 + sizeof(IndigoPayload)) {
    IndigoPayload *digitizer = (IndigoPayload *)((uint8_t *)message + 0xC0);
    digitizer->event.touch.xRatio = a.x;
    digitizer->event.touch.yRatio = a.y;
  }
  if (size >= 0x160 + sizeof(IndigoPayload)) {
    IndigoPayload *finger = (IndigoPayload *)((uint8_t *)message + 0x160);
    finger->event.touch.xRatio = b.x;
    finger->event.touch.yRatio = b.y;
  }
  hidSend(message);
}

// A drag that starts on a screen edge is what iOS reads as a system gesture: up from the
// bottom for Home, down from the top for Notification Centre, in from the left for Back.
static uint32_t edgeAt(double x, double y) {
  if (y >= 0.98) return EdgeBottom;
  if (y <= 0.015) return EdgeTop;
  if (x <= 0.012) return EdgeLeft;
  if (x >= 0.988) return EdgeRight;
  return EdgeNone;
}

// iOS keeps the velocity of the last movement when a finger lifts, however long it stood
// still: a few tiny moves first tell it the finger stopped, so it does not fling.
static void settleAt(double x, double y, uint32_t edge) {
  double e = pointsHeight > 0 ? 0.4 / pointsHeight : 0.0005;
  double y2 = y + e <= 1 ? y + e : y - e;
  for (int i = 0; i < 2; i++) {
    sendTouch(x, y2, DirectionDown, edge);
    usleep(16000);
    sendTouch(x, y, DirectionDown, edge);
    usleep(16000);
  }
}

static void liftWheel(void) {
  if (!wheelDown) return;
  settleAt(wheelX, wheelY, EdgeNone);
  sendTouch(wheelX, wheelY, DirectionUp, EdgeNone);
  wheelDown = false;
}

static void liftAll(void) {
  liftWheel();
  if (fingerDown) sendTouch(fingerX, fingerY, DirectionUp, fingerEdge);
  if (twoDown) sendTwoFingers(twoX1, twoY1, twoX2, twoY2, DirectionUp);
  fingerDown = false;
  twoDown = false;
}

static void touchCommand(char phase, double x, double y) {
  if (phase == 'd') {
    liftWheel();
    if (fingerDown) sendTouch(fingerX, fingerY, DirectionUp, fingerEdge);
    fingerEdge = edgeAt(x, y);
    fingerDown = true;
    fingerDragged = false;
    fingerX = fingerStartX = x;
    fingerY = fingerStartY = y;
    fingerMovedNs = uptimeNs();
    sendTouch(x, y, DirectionDown, fingerEdge);
  } else if (phase == 'm') {
    if (!fingerDown || (x == fingerX && y == fingerY)) return;
    fingerX = x;
    fingerY = y;
    fingerMovedNs = uptimeNs();
    if (hypot((x - fingerStartX) * pointsWidth, (y - fingerStartY) * pointsHeight) > 8) fingerDragged = true;
    // A move is another touch-down at the new position (the builder takes only down and up).
    sendTouch(x, y, DirectionDown, fingerEdge);
  } else if (phase == 'u') {
    if (!fingerDown) return;
    // A drag released while moving: let iOS fling, as a real finger would. Held still: no fling.
    // A tap lifts at once.
    if (fingerDragged && uptimeNs() - fingerMovedNs > 60 * NSEC_PER_MSEC) settleAt(x, y, fingerEdge);
    sendTouch(x, y, DirectionUp, fingerEdge);
    fingerDown = false;
  }
}

static void twoFingerCommand(char phase, double x1, double y1, double x2, double y2) {
  if (phase == 'd') {
    liftAll();
    twoDown = true;
  } else if (!twoDown) {
    return;
  }
  twoX1 = x1; twoY1 = y1; twoX2 = x2; twoY2 = y2;
  sendTwoFingers(x1, y1, x2, y2, phase == 'u' ? DirectionUp : DirectionDown);
  if (phase == 'u') twoDown = false;
}

// Scrolling as a finger drag that follows the wheel: the finger moves against the scroll
// direction, in small steps (iOS tracks big jumps poorly), and is held still before it lifts
// so iOS adds no fling of its own (the PC's touchpad already sends its momentum as more
// wheel events).
// Measured: 4 ms between 24-point steps tracks best (2 ms loses a third of the distance).
static const useconds_t WheelStepUs = 4000;

static double clampTo(double v, double lo, double hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

static void wheelMoveTo(double nx, double ny) {
  double dxp = (nx - wheelX) * pointsWidth, dyp = (ny - wheelY) * pointsHeight;
  int steps = (int)ceil(fmax(fabs(dxp), fabs(dyp)) / 24.0);
  if (steps < 1) steps = 1;
  double sx = wheelX, sy = wheelY;
  for (int i = 1; i <= steps; i++) {
    if (i > 1) usleep(WheelStepUs);
    sendTouch(sx + (nx - sx) * i / steps, sy + (ny - sy) * i / steps, DirectionDown, EdgeNone);
  }
  wheelX = nx;
  wheelY = ny;
}

static void wheelCommand(double x, double y, double dx, double dy) {
  if (fingerDown || twoDown || pointsWidth <= 0 || pointsHeight <= 0) return;
  double mx = -dx / pointsWidth, my = -dy / pointsHeight;
  double length = hypot(dx, dy);
  if (length < 0.01) return;
  // Out of room: lift, and carry on from the pointer.
  if (wheelDown && (wheelX + mx < 0.04 || wheelX + mx > 0.96 || wheelY + my < 0.06 || wheelY + my > 0.94)) liftWheel();
  if (!wheelDown) {
    wheelX = clampTo(x, 0.04, 0.96);
    wheelY = clampTo(y, 0.06, 0.94);
    sendTouch(wheelX, wheelY, DirectionDown, EdgeNone);
    wheelDown = true;
    // Past iOS's touch slop first, so this scroll moves the content by all of its delta.
    usleep(2000);
    const double slop = 12.0;
    wheelMoveTo(clampTo(wheelX + mx * slop / length, 0, 1), clampTo(wheelY + my * slop / length, 0, 1));
  }
  wheelMoveTo(clampTo(wheelX + mx, 0, 1), clampTo(wheelY + my, 0, 1));
  wheelLastNs = uptimeNs();
}

static void wheelTick(void) {
  if (wheelDown && uptimeNs() - wheelLastNs > 120 * NSEC_PER_MSEC) liftWheel();
}

static int32_t buttonSource(const char *name) {
  if (!strcmp(name, "home")) return 0x0;
  if (!strcmp(name, "lock")) return 0x1;
  if (!strcmp(name, "side")) return 0xbb8;
  if (!strcmp(name, "siri")) return 0x400002;
  if (!strcmp(name, "applepay")) return 0x1f4;
  return -1;
}

static int compareVersions(NSString *a, NSString *b) {
  return (int)[a compare:b options:NSNumericSearch];
}

static void setupInput(id device, NSString *developerDir) {
  if (!wantInput) {
    inputUnavailable = @"Input is turned off.";
    return;
  }
  NSString *coreSimulator = [[NSBundle bundleForClass:NSClassFromString(@"SimDevice")] infoDictionary][@"CFBundleVersion"] ?: @"";
  // CoreSimulator 1155.4 (Xcode 27) ignores legacy Indigo input; it needs Apple's newer HID service.
  if (coreSimulator.length && compareVersions(coreSimulator, @"1155.4") >= 0) {
    inputUnavailable = [NSString stringWithFormat:@"This Xcode's simulator (CoreSimulator %@) takes input through a service CapMac does not support yet.", coreSimulator];
    return;
  }
  NSString *kitPath = [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  void *kit = dlopen(kitPath.fileSystemRepresentation, RTLD_NOW);
  if (!kit) {
    inputUnavailable = [NSString stringWithFormat:@"SimulatorKit did not load: %s", dlerror()];
    return;
  }
  mouseFn = (IndigoMouseFn)dlsym(kit, "IndigoHIDMessageForMouseNSEvent");
  buttonFn = (IndigoButtonFn)dlsym(kit, "IndigoHIDMessageForButton");
  keyboardFn = (IndigoKeyboardFn)dlsym(kit, "IndigoHIDMessageForKeyboardArbitrary");
  hidArbitraryFn = (IndigoHIDArbitraryFn)dlsym(kit, "IndigoHIDMessageForHIDArbitrary");
  Class clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  if (!mouseFn || !buttonFn || !clientClass) {
    inputUnavailable = @"This Xcode's SimulatorKit has no Indigo HID input.";
    return;
  }
  NSError *error = nil;
  @try {
    hidClient = [(id<CMLegacyHIDClient>)[clientClass alloc] initWithDevice:device error:&error];
  } @catch (NSException *e) {
    inputUnavailable = [NSString stringWithFormat:@"The simulator's input client failed: %@", e.reason];
    return;
  }
  if (!hidClient) inputUnavailable = [NSString stringWithFormat:@"The simulator's input client failed: %@", error.localizedDescription ?: @"unknown error"];
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
      if (surface && setupEncoder()) {
        dirty = true;
        encodeSoon();
      }
    });
  } else if (cmd == 'r') {
    // A new average bitrate (adaptive bitrate over the internet); the byte budget follows it.
    long value = strtol(line + 1, NULL, 10);
    if (value < 200000 || value > 20000000) return;
    dispatch_async(encodeQueue, ^{
      if ((int)value == bitrate) return;
      bitrate = (int)value;
      if (session) VTSessionSetProperty(session, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFNumberRef)@(bitrate));
      if (budgetBytes > budgetPerSecond() / 2) budgetBytes = budgetPerSecond() / 2;
      LOG("bitrate %d bps", bitrate);
    });
  } else if (cmd == 'q') {
    shutdownAndExit(0);
  } else if (!hidClient) {
    static bool told = false;
    if (!told) emitEvent(@{@"t": @"input-error", @"message": inputUnavailable ?: @"Input is not available."});
    told = true;
  } else if (cmd == 't') {
    char phase = 0;
    double x = 0, y = 0;
    if (sscanf(line + 1, " %c %lf %lf", &phase, &x, &y) != 3) return;
    dispatch_async(hidQueue, ^{ touchCommand(phase, x, y); });
  } else if (cmd == 'T') {
    char phase = 0;
    double x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    if (sscanf(line + 1, " %c %lf %lf %lf %lf", &phase, &x1, &y1, &x2, &y2) != 5) return;
    dispatch_async(hidQueue, ^{ twoFingerCommand(phase, x1, y1, x2, y2); });
  } else if (cmd == 'c') {
    dispatch_async(hidQueue, ^{ liftAll(); });
  } else if (cmd == 'w') {
    double x = 0, y = 0, dx = 0, dy = 0;
    if (sscanf(line + 1, " %lf %lf %lf %lf", &x, &y, &dx, &dy) != 4) return;
    dispatch_async(hidQueue, ^{ wheelCommand(x, y, dx, dy); });
  } else if (cmd == 'b') {
    char name[16] = {0}, phase = 0;
    if (sscanf(line + 1, " %15s %c", name, &phase) != 2) return;
    int32_t source = buttonSource(name);
    if (source < 0) return;
    int32_t direction = phase == 'u' ? DirectionUp : DirectionDown;
    dispatch_async(hidQueue, ^{ hidSend(buttonFn(source, direction, TargetHardware)); });
  } else if (cmd == 'K') {
    unsigned int usage = 0;
    char phase = 0;
    if (sscanf(line + 1, " %u %c", &usage, &phase) != 2 || usage == 0 || usage > 0xFFFF) return;
    int32_t direction = phase == 'u' ? DirectionUp : DirectionDown;
    dispatch_async(hidQueue, ^{
      if (keyboardFn) hidSend(keyboardFn((int32_t)usage, direction));
      else if (hidArbitraryFn) hidSend(hidArbitraryFn(TargetDigitizer, 7, usage, direction));
    });
  }
}

// ─── Lifetime ────────────────────────────────────────────────────────────────
static NSUUID *callbackToken;
static bool screenApi = false;

static void shutdownAndExit(int code) {
  static atomic_bool exiting = false;
  if (atomic_exchange(&exiting, true)) {
    // Another thread is already on its way out.
    for (;;) pause();
  }
  // Never leave a finger down on the simulator.
  if (hidClient && hidQueue) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(hidQueue, ^{
      liftAll();
      dispatch_semaphore_signal(done);
    });
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC));
    usleep(50000); // let the last message reach the simulator
  }
  if (display && callbackToken) {
    @try {
      if (screenApi) [display unregisterScreenCallbacksWithUUID:callbackToken];
      else {
        [display unregisterDamageRectanglesCallbackWithUUID:callbackToken];
        [display unregisterIOSurfacesChangeCallbackWithUUID:callbackToken];
      }
    } @catch (NSException *e) {
      // the simulator is already gone
    }
  }
  exit(code);
}

static long footprintBytes(void) {
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return 0;
  return (long)info.phys_footprint;
}

static uint32_t surfaceId(id s) {
  return s ? IOSurfaceGetID((__bridge IOSurfaceRef)s) : 0;
}

static void statusTick(void) {
  static long lastCallbacks = 0, lastEncoded = 0, lastSent = 0, lastDropped = 0;
  long callbacks = atomic_load(&callbackCount), encoded = atomic_load(&encodedCount), sent = atomic_load(&sentCount), dropped = atomic_load(&droppedCount);
  uint32_t seed = surface ? IOSurfaceGetSeed(surface) : 0;
  long frames = callbacks - lastCallbacks, n = encoded - lastEncoded;
  emitEvent(@{
    @"t": @"status",
    @"callbacks": @(frames),
    @"encoded": @(n),
    @"sent": @(sent - lastSent),
    @"dropped": @(dropped - lastDropped),
    @"seed": @(seed),
    @"footprint": @(footprintBytes()),
    @"queued": @(atomic_load(&queuedBytes)),
    @"width": @(outWidth),
    @"height": @(outHeight),
  });
  if (debug) LOG("debug: callbacks/s=%ld encoded/s=%ld sent/s=%ld dropped/s=%ld transfer=%.1fms submit=%.1fms footprint=%.1fMB", frames, n, sent - lastSent, dropped - lastDropped, n ? transferMs / n : 0, n ? submitMs / n : 0, footprintBytes() / 1048576.0);
  lastCallbacks = callbacks;
  lastEncoded = encoded;
  lastSent = sent;
  lastDropped = dropped;
  transferMs = 0;
  submitMs = 0;
  if (atomic_load(&awaitingKey) && atomic_load(&queuedBytes) < 512 * 1024) {
    forceKey = true;
    encodeSoon();
  }
  // A quiet screen may also mean CoreSimulator swapped the framebuffer without telling us:
  // look again, and follow it if it moved.
  if (display && uptimeNs() - lastCallbackNs > 2 * NSEC_PER_SEC) {
    dispatch_async(dispatch_get_main_queue(), ^{
      id current = nil;
      @try {
        current = display.framebufferSurface;
      } @catch (NSException *e) {
        return;
      }
      if (!current) return;
      dispatch_async(encodeQueue, ^{
        if (surfaceId(current) != (surface ? IOSurfaceGetID(surface) : 0)) {
          LOG("framebuffer moved, following it");
          setSurface(current);
          encodeSoon();
        }
      });
    });
  }
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      LOG("usage: simstream <udid> [--developer-dir DIR] [--max-size N] [--fps N] [--bitrate N] [--video 0|1] [--input 0|1] [--debug 1]");
      return 2;
    }
    signal(SIGPIPE, SIG_IGN);
    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    NSString *developerDir = @"/Applications/Xcode.app/Contents/Developer";
    for (int i = 2; i + 1 < argc; i += 2) {
      if (!strcmp(argv[i], "--max-size")) maxSize = MAX(320, MIN(4096, atoi(argv[i + 1])));
      else if (!strcmp(argv[i], "--fps")) fps = MAX(1, MIN(120, atoi(argv[i + 1])));
      else if (!strcmp(argv[i], "--bitrate")) bitrate = MAX(250000, MIN(50000000, atoi(argv[i + 1])));
      else if (!strcmp(argv[i], "--debug")) debug = atoi(argv[i + 1]) != 0;
      else if (!strcmp(argv[i], "--video")) wantVideo = atoi(argv[i + 1]) != 0;
      else if (!strcmp(argv[i], "--input")) wantInput = atoi(argv[i + 1]) != 0;
      else if (!strcmp(argv[i], "--developer-dir")) developerDir = [NSString stringWithUTF8String:argv[i + 1]];
    }
    outQueue = serialQueue("capmac.out");
    encodeQueue = serialQueue("capmac.encode");
    hidQueue = serialQueue("capmac.hid");

    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) {
      fatal(@"CORESIMULATOR", [NSString stringWithFormat:@"CoreSimulator did not load: %s", dlerror()], 4);
    }
    Class contextClass = NSClassFromString(@"SimServiceContext");
    NSError *error = nil;
    id<CMSimServiceContext> context = [(id)contextClass sharedServiceContextForDeveloperDir:developerDir error:&error];
    id<CMSimDeviceSet> set = context ? [context defaultDeviceSetWithError:&error] : nil;
    if (!set) fatal(@"CORESIMULATOR", [NSString stringWithFormat:@"CoreSimulator did not answer: %@", error.localizedDescription ?: @"unknown error"], 4);
    id<CMSimDevice> device = nil;
    for (id<CMSimDevice> d in set.devices) if ([d.UDID.UUIDString isEqualToString:udid]) device = d;
    if (!device) fatal(@"NO_DEVICE", [NSString stringWithFormat:@"There is no simulator %@ on this Mac.", udid], 5);

    // The screen's size in points: the device type's pixels over its scale.
    id<CMSimDeviceType> type = [(id)device deviceType];
    CGSize pixels = type ? type.mainScreenSize : CGSizeZero;
    float scale = type ? type.mainScreenScale : 0;
    if (scale > 0) {
      pointsWidth = pixels.width / scale;
      pointsHeight = pixels.height / scale;
    }

    if (wantVideo) {
      for (id<CMSimPort> port in [(id<CMSimDeviceIO>)device.io ioPorts]) {
        id descriptor = port.descriptor;
        if (![descriptor respondsToSelector:@selector(framebufferSurface)]) continue;
        if ([descriptor respondsToSelector:@selector(displayClass)] && [descriptor displayClass] != 0) continue;
        // Xcode 26 lists several screens (the device's LCD, TV out, CarPlay); the device's own is type 0.
        if ([descriptor respondsToSelector:@selector(screenProperties)]) {
          id props = [descriptor screenProperties];
          if (((unsigned long long (*)(id, SEL))objc_msgSend)(props, sel_registerName("screenType")) != 0) continue;
        }
        display = descriptor;
        break;
      }
      if (!display) fatal(@"NO_DISPLAY", [NSString stringWithFormat:@"%@ has no screen to stream: is it booted?", device.name], 6);
    }

    setupInput(device, developerDir);
    if (hidClient) {
      wheelTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, hidQueue);
      dispatch_source_set_timer(wheelTimer, DISPATCH_TIME_NOW, 30 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
      dispatch_source_set_event_handler(wheelTimer, ^{ wheelTick(); });
      dispatch_resume(wheelTimer);
    }

    if (display) {
      callbackToken = [NSUUID UUID];
      screenApi = [(id)display respondsToSelector:@selector(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)];
      if (screenApi) {
        [display registerScreenCallbacksWithUUID:callbackToken callbackQueue:encodeQueue frameCallback:^{
          markDirty();
        } surfacesChangedCallback:^(id framebuffer, id masked) {
          setSurface(framebuffer);
          encodeSoon();
        } propertiesChangedCallback:^(id properties) {
          if (debug) LOG("screen properties changed");
        }];
      } else {
        [display registerCallbackWithUUID:callbackToken ioSurfacesChangeCallback:^(id framebuffer, id masked) {
          dispatch_async(encodeQueue, ^{
            setSurface(framebuffer);
            encodeSoon();
          });
        }];
        [display registerCallbackWithUUID:callbackToken damageRectanglesCallback:^(NSArray *rects) {
          dispatch_async(encodeQueue, ^{ markDirty(); });
        }];
      }
      id framebuffer = display.framebufferSurface;
      dispatch_async(encodeQueue, ^{
        setSurface(framebuffer);
        encodeSoon();
      });
    }

    NSMutableDictionary *hello = [@{
      @"t": @"hello",
      @"device": device.name ?: @"",
      @"video": @(display != nil),
      @"api": display ? (screenApi ? @"SimScreen" : @"SimDisplayRenderable") : @"none",
      @"input": @(hidClient != nil),
      @"coreSimulator": [[NSBundle bundleForClass:NSClassFromString(@"SimDevice")] infoDictionary][@"CFBundleVersion"] ?: @"",
    } mutableCopy];
    if (scale > 0) {
      hello[@"scale"] = @(scale);
      hello[@"pixels"] = @{@"width": @(pixels.width), @"height": @(pixels.height)};
      hello[@"points"] = @{@"width": @(round(pointsWidth)), @"height": @(round(pointsHeight))};
    }
    if (inputUnavailable) hello[@"inputReason"] = inputUnavailable;
    emitEvent(hello);
    LOG("streaming %s (%s, input %s)", device.name.UTF8String, display ? (screenApi ? "SimScreen" : "SimDisplayRenderable") : "no video", hidClient ? "on" : inputUnavailable.UTF8String);

    statusTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, encodeQueue);
    dispatch_source_set_timer(statusTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, 50 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(statusTimer, ^{ statusTick(); });
    dispatch_resume(statusTimer);

    // SIGTERM and SIGINT (the agent stopping the stream) quit cleanly: no finger left down.
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    termSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    dispatch_source_set_event_handler(termSource, ^{ shutdownAndExit(0); });
    dispatch_resume(termSource);
    intSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    dispatch_source_set_event_handler(intSource, ^{ shutdownAndExit(0); });
    dispatch_resume(intSource);

    // Commands on stdin; when it closes, the agent is gone and so are we.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
      char line[512];
      while (fgets(line, sizeof line, stdin)) {
        @autoreleasepool {
          handleCommand(line);
        }
      }
      shutdownAndExit(0);
    });
    // CoreSimulator delivers display callbacks through the main run loop (dispatch_main would never see them).
    CFRunLoopRun();
  }
  return 0;
}
