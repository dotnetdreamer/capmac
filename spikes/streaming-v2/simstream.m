// capmac simstream (spike): the iOS simulator's framebuffer as an H.264 stream.
//
//   simstream <udid> [--max-size 1400] [--fps 60] [--bitrate 6000000] [--low-latency 0|1] [--debug 1]
//
// Capture: CoreSimulator's display port. Xcode 26: SimScreen frame callbacks and the
// framebuffer IOSurface (older Xcode: SimDisplayRenderable damage callbacks). Frames are
// produced only when the screen changes; no Screen Recording permission is needed.
// Encode: VideoToolbox H.264, real-time, no B-frames, standard rate control (low-latency
// rate control, --low-latency 1, drops frames at 6 Mbps under full-screen motion).
//
// stdout, one message per frame:  u32 length (big endian, of everything after it)
//   u8 type   1 = config (payload: u16 width, u16 height, avcC record)
//             2 = frame  (payload: AVCC length-prefixed NAL units)
//             3 = pong   (payload: u64 echo, the value from the ping)
//   u8 flags  bit 0: keyframe
//   u16 reserved
//   u64 capture time, Unix epoch microseconds on the Mac's clock
//   u32 sequence number
//   payload
// stdin, one command per line:  k = keyframe now,  p<number> = pong,  q = quit
// stderr: log lines.
#import <Foundation/Foundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <sys/time.h>

#define LOG(...) do { fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); fflush(stderr); } while (0)

// ─── Private API shapes (Xcode 26) ───────────────────────────────────────────
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

// ─── Output ──────────────────────────────────────────────────────────────────
static dispatch_queue_t outQueue;
static uint32_t seq = 0;

static uint64_t nowUs(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000000ull + (uint64_t)tv.tv_usec;
}

static void writeAll(const void *bytes, size_t length) {
  const uint8_t *p = bytes;
  while (length > 0) {
    ssize_t n = write(STDOUT_FILENO, p, length);
    if (n <= 0) {
      if (errno == EINTR) continue;
      exit(0); // the reader went away
    }
    p += n;
    length -= (size_t)n;
  }
}

static void emit(uint8_t type, uint8_t flags, uint64_t captureUs, NSData *payload) {
  NSData *copy = [payload copy];
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
  });
}

// ─── Encoder ─────────────────────────────────────────────────────────────────
static VTCompressionSessionRef session;
static volatile long outputCount = 0, droppedCount = 0;
static VTPixelTransferSessionRef transfer;
static int32_t outWidth = 0, outHeight = 0;
static int maxSize = 1400, fps = 60, bitrate = 6000000, lowLatency = 0;
static volatile bool forceKey = true;
static bool configSent = false;
static NSData *lastConfig;

static void sendConfig(CMFormatDescriptionRef format) {
  const uint8_t *sps = NULL, *pps = NULL;
  size_t spsLen = 0, ppsLen = 0, count = 0;
  int nalHeader = 0;
  if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, &sps, &spsLen, &count, &nalHeader) != noErr) return;
  if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 1, &pps, &ppsLen, NULL, NULL) != noErr) return;
  // AVCDecoderConfigurationRecord (ISO 14496-15), what WebCodecs wants as `description`.
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
  if (flags & kVTEncodeInfo_FrameDropped) droppedCount++;
  if (status != noErr || !sample) {
    if (status != noErr) LOG("encode error %d", (int)status);
    return;
  }
  outputCount++;
  bool key = true;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  if (attachments && CFArrayGetCount(attachments) > 0) {
    CFDictionaryRef a = CFArrayGetValueAtIndex(attachments, 0);
    key = !CFDictionaryContainsKey(a, kCMSampleAttachmentKey_NotSync);
  }
  if (key) sendConfig(CMSampleBufferGetFormatDescription(sample));
  if (!configSent) return;
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  size_t length = 0;
  char *data = NULL;
  if (CMBlockBufferGetDataPointer(block, 0, NULL, &length, &data) != noErr) return;
  uint64_t captureUs = (uint64_t)(uintptr_t)frameRef;
  emit(2, key ? 1 : 0, captureUs, [NSData dataWithBytes:data length:length]);
}

static void setupEncoder(int32_t width, int32_t height) {
  if (session) {
    VTCompressionSessionCompleteFrames(session, kCMTimeInvalid);
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
    session = NULL;
  }
  double scale = MIN(1.0, (double)maxSize / (double)MAX(width, height));
  outWidth = ((int32_t)(width * scale)) & ~1;
  outHeight = ((int32_t)(height * scale)) & ~1;
  NSDictionary *spec = lowLatency ? @{(__bridge NSString *)kVTVideoEncoderSpecification_EnableLowLatencyRateControl: @YES} : @{};
  NSDictionary *source = @{
    (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
    (__bridge NSString *)kCVPixelBufferWidthKey: @(outWidth),
    (__bridge NSString *)kCVPixelBufferHeightKey: @(outHeight),
    (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  OSStatus st = VTCompressionSessionCreate(NULL, outWidth, outHeight, kCMVideoCodecType_H264, (__bridge CFDictionaryRef)spec, (__bridge CFDictionaryRef)source, NULL, onEncoded, NULL, &session);
  if (st != noErr) {
    LOG("VTCompressionSessionCreate failed %d", (int)st);
    exit(3);
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
  LOG("encoder %dx%d (from %dx%d), %d fps, %d bps", outWidth, outHeight, width, height, fps, bitrate);
}

// ─── Capture ─────────────────────────────────────────────────────────────────
static IOSurfaceRef surface;
static volatile bool dirty = true;
static volatile uint64_t dirtyAtUs = 0;
static volatile long damageCount = 0;
static volatile long encodedCount = 0;
static volatile double transferMs = 0, submitMs = 0;
static bool debug = false;
static dispatch_queue_t encodeQueue;
// Held for the life of the process: under ARC a timer nobody references is released and stops.
static dispatch_source_t frameTimer, debugTimer;

static void setSurface(id s) {
  dispatch_async(encodeQueue, ^{
    if (surface) CFRelease(surface);
    surface = s ? (IOSurfaceRef)CFRetain((__bridge CFTypeRef)s) : NULL;
    if (surface) {
      int32_t w = (int32_t)IOSurfaceGetWidth(surface), h = (int32_t)IOSurfaceGetHeight(surface);
      setupEncoder(w, h);
      dirty = true;
      dirtyAtUs = nowUs();
    }
  });
}

static void encodeIfDirty(void) {
  if (!surface || !session || (!dirty && !forceKey)) return;
  uint64_t captureUs = dirtyAtUs ? dirtyAtUs : nowUs();
  dirty = false;
  dirtyAtUs = 0;
  CVPixelBufferRef src = NULL;
  if (CVPixelBufferCreateWithIOSurface(NULL, surface, NULL, &src) != kCVReturnSuccess) return;
  CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(session);
  CVPixelBufferRef dst = NULL;
  if (!pool || CVPixelBufferPoolCreatePixelBuffer(NULL, pool, &dst) != kCVReturnSuccess) {
    CVPixelBufferRelease(src);
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
  VTCompressionSessionEncodeFrame(session, dst, pts, kCMTimeInvalid, (__bridge CFDictionaryRef)props, (void *)(uintptr_t)captureUs, NULL);
  uint64_t t2 = mach_absolute_time();
  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb);
  transferMs += (double)(t1 - t0) * tb.numer / tb.denom / 1e6;
  submitMs += (double)(t2 - t1) * tb.numer / tb.denom / 1e6;
  encodedCount++;
  CVPixelBufferRelease(dst);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      LOG("usage: simstream <udid> [--max-size N] [--fps N] [--bitrate N]");
      return 2;
    }
    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    for (int i = 2; i + 1 < argc; i += 2) {
      if (!strcmp(argv[i], "--max-size")) maxSize = atoi(argv[i + 1]);
      else if (!strcmp(argv[i], "--fps")) fps = atoi(argv[i + 1]);
      else if (!strcmp(argv[i], "--bitrate")) bitrate = atoi(argv[i + 1]);
      else if (!strcmp(argv[i], "--debug")) debug = atoi(argv[i + 1]) != 0;
      else if (!strcmp(argv[i], "--low-latency")) lowLatency = atoi(argv[i + 1]);
    }
    outQueue = dispatch_queue_create("capmac.out", DISPATCH_QUEUE_SERIAL);
    encodeQueue = dispatch_queue_create("capmac.encode", DISPATCH_QUEUE_SERIAL);

    NSString *developerDir = @"/Applications/Xcode.app/Contents/Developer";
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) { LOG("CoreSimulator: %s", dlerror()); return 4; }
    Class contextClass = NSClassFromString(@"SimServiceContext");
    NSError *error = nil;
    id<CMSimServiceContext> context = [(id)contextClass sharedServiceContextForDeveloperDir:developerDir error:&error];
    id<CMSimDeviceSet> set = [context defaultDeviceSetWithError:&error];
    id<CMSimDevice> device = nil;
    for (id<CMSimDevice> d in set.devices) if ([d.UDID.UUIDString isEqualToString:udid]) device = d;
    if (!device) { LOG("no simulator %s", udid.UTF8String); return 5; }
    id<CMSimDisplay> display = nil;
    for (id<CMSimPort> port in [(id<CMSimDeviceIO>)device.io ioPorts]) {
      id descriptor = port.descriptor;
      if (![descriptor respondsToSelector:@selector(framebufferSurface)]) continue;
      if ([descriptor respondsToSelector:@selector(displayClass)] && [descriptor displayClass] != 0) continue;
      // Xcode 26: several screens (the device's LCD, TV out, CarPlay); the device's own is type 0.
      if ([descriptor respondsToSelector:@selector(screenProperties)]) {
        id props = [descriptor screenProperties];
        if (((unsigned long long (*)(id, SEL))objc_msgSend)(props, sel_registerName("screenType")) != 0) continue;
      }
      display = descriptor;
      break;
    }
    if (!display) { LOG("no display port (is %s booted?)", device.name.UTF8String); return 6; }
    LOG("streaming %s", device.name.UTF8String);

    NSUUID *token = [NSUUID UUID];
    void (^damaged)(void) = ^{
      damageCount++;
      if (!dirty) dirtyAtUs = nowUs();
      dirty = true;
    };
    bool screenApi = [(id)display respondsToSelector:@selector(registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:)];
    if (screenApi) {
      dispatch_queue_t callbacks = dispatch_queue_create("capmac.screen", DISPATCH_QUEUE_SERIAL);
      [display registerScreenCallbacksWithUUID:token callbackQueue:callbacks frameCallback:damaged surfacesChangedCallback:^(id framebuffer, id masked) {
        setSurface(framebuffer);
      } propertiesChangedCallback:^(id properties) {
        if (debug) LOG("screen properties changed");
      }];
    } else {
      [display registerCallbackWithUUID:token ioSurfacesChangeCallback:^(id framebuffer, id masked) { setSurface(framebuffer); }];
      [display registerCallbackWithUUID:token damageRectanglesCallback:^(NSArray *rects) { damaged(); }];
    }
    LOG("callbacks: %s", screenApi ? "SimScreen" : "SimDisplayRenderable");
    if (debug && screenApi) {
      @try {
        id props = [display screenProperties];
        id (*msgId)(id, SEL) = (id (*)(id, SEL))objc_msgSend;
        int (*msgInt)(id, SEL) = (int (*)(id, SEL))objc_msgSend;
        id backlight = msgId(props, sel_registerName("backlight"));
        LOG("screen %d '%s' power=%d type=%d backlight=%d", msgInt(props, sel_registerName("screenID")), [[msgId(props, sel_registerName("name")) description] UTF8String], msgInt(props, sel_registerName("powerState")), msgInt(props, sel_registerName("screenType")), backlight ? msgInt(backlight, sel_registerName("state")) : -1);
      } @catch (NSException *e) {
        LOG("screen properties failed: %s", e.reason.UTF8String);
      }
    }
    setSurface(display.framebufferSurface);

    // Frame clock: encode at most `fps` times a second, only when something changed.
    frameTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, encodeQueue);
    dispatch_source_set_timer(frameTimer, DISPATCH_TIME_NOW, NSEC_PER_SEC / (uint64_t)fps, NSEC_PER_MSEC);
    dispatch_source_set_event_handler(frameTimer, ^{ encodeIfDirty(); });
    dispatch_resume(frameTimer);

    if (debug) {
      dispatch_source_t dbg = debugTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
      dispatch_source_set_timer(dbg, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_MSEC * 10);
      dispatch_source_set_event_handler(dbg, ^{
        IOSurfaceRef sf = surface;
        static long lastEncoded = 0;
        long n = encodedCount - lastEncoded;
        static long lastOut = 0, lastDropped = 0;
        LOG("debug: damage=%ld encoded/s=%ld out/s=%ld dropped/s=%ld transfer=%.1fms submit=%.1fms", damageCount, n, outputCount - lastOut, droppedCount - lastDropped, n ? transferMs / n : 0, n ? submitMs / n : 0);
        lastOut = outputCount;
        lastDropped = droppedCount;
        lastEncoded = encodedCount;
        transferMs = 0;
        submitMs = 0;
      });
      dispatch_resume(dbg);
    }
    // Commands on stdin.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      char line[256];
      while (fgets(line, sizeof line, stdin)) {
        if (line[0] == 'k') { forceKey = true; dirty = true; }
        else if (line[0] == 'p') {
          uint64_t echo = strtoull(line + 1, NULL, 10);
          uint8_t b[8];
          for (int i = 0; i < 8; i++) b[i] = (uint8_t)(echo >> (56 - 8 * i));
          emit(3, 0, nowUs(), [NSData dataWithBytes:b length:8]);
        } else if (line[0] == 'q') break;
      }
      if (screenApi) [display unregisterScreenCallbacksWithUUID:token];
      else {
        [display unregisterDamageRectanglesCallbackWithUUID:token];
        [display unregisterIOSurfacesChangeCallbackWithUUID:token];
      }
      exit(0);
    });
    // CoreSimulator delivers display callbacks through the main run loop (dispatch_main would never see them).
    CFRunLoopRun();
  }
}
