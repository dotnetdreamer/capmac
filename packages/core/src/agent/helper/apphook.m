// CapMac's module for native Mac apps (a Flutter app's Mac app), loaded with
// DYLD_INSERT_LIBRARIES by the agent when it launches a debug build.
//
// It speaks the protocol of CapMac's Electron module (src/shared/electron.ts:
// HookRequest in, HookMessage out, framed as in src/shared/frames.ts), so the
// agent's `electron-screen` op, CapMac Studio's app window pane and the CLI's
// viewer work with it unchanged:
//
//  - The app stays in the background on the Mac: it never activates itself or
//    orders its windows in front while it is not the active app, so whoever
//    works on the Mac keeps their keyboard and their windows.
//  - Its window comes to the PC as H.264 (VideoToolbox) or JPEG. A Flutter
//    window's frames come straight from the surfaces Flutter draws into (so
//    it shows while the Mac is locked or the window is covered); other
//    windows are captured with ScreenCaptureKit's own-process content (an app
//    may always capture its own windows: no Screen Recording permission).
//  - Clicks, scrolls, keys and text from the PC go into the window as AppKit
//    events, from inside the app: no Accessibility permission either.
//
// Apps are often sandboxed (Flutter's template is): the module listens on a
// TCP port on 127.0.0.1 (the sandbox allows that with network.server) and the
// first message on a connection must carry the token the agent passed.
//
// CAPMAC_APP_HOOK="<port>:<token>" turns it on; without it the module does nothing.

#import <AppKit/AppKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <IOSurface/IOSurface.h>
#import <objc/runtime.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sys/socket.h>
#include <unistd.h>

// ─── State ───────────────────────────────────────────────────────────────────

static int gPort = 0;
static NSString *gToken = nil;
static int gServer = -1;
/** The app may come to the front only while it is the active app (someone clicked it on the Mac). */
static atomic_bool gStarted = false;

@class CMClient;
static NSMutableArray<CMClient *> *gClients;
static NSObject *gLock;

static void markLine(NSDictionary *event);
static void sendWindows(void);

// ─── Connections ─────────────────────────────────────────────────────────────

@interface CMClient : NSObject {
 @public
  atomic_long _pending;
}
@property(nonatomic) int fd;
@property(nonatomic) BOOL authed;
@property(nonatomic) BOOL screen;
@property(nonatomic) int inflight;
@property(nonatomic, strong) dispatch_queue_t writes;
@end

@implementation CMClient
- (void)write:(NSData *)data droppable:(BOOL)droppable {
  // A slow viewer gets fewer video deltas rather than an ever longer queue.
  if (droppable && atomic_load(&_pending) > 2 * 1024 * 1024) return;
  atomic_fetch_add(&_pending, (long)data.length);
  int fd = self.fd;
  dispatch_async(self.writes, ^{
    const uint8_t *bytes = data.bytes;
    size_t left = data.length;
    while (left > 0) {
      ssize_t n = send(fd, bytes, left, 0);
      if (n <= 0) break;
      bytes += n;
      left -= (size_t)n;
    }
    atomic_fetch_sub(&self->_pending, (long)data.length);
  });
}
@end

static NSData *frame(uint8_t kind, NSData *payload) {
  uint32_t length = htonl((uint32_t)payload.length + 1);
  NSMutableData *out = [NSMutableData dataWithBytes:&length length:4];
  [out appendBytes:&kind length:1];
  [out appendData:payload];
  return out;
}

static NSData *json(NSDictionary *value) {
  return [NSJSONSerialization dataWithJSONObject:value options:0 error:nil] ?: [NSData data];
}

static void sendTo(CMClient *client, NSDictionary *message, NSData *binary, BOOL droppable) {
  NSMutableData *out = [frame(0, json(message)) mutableCopy];
  if (binary) [out appendData:frame(1, binary)];
  [client write:out droppable:droppable];
}

/** To every connection watching the window. */
static void broadcast(NSDictionary *message, NSData *binary, BOOL droppable) {
  NSArray *clients;
  @synchronized(gLock) {
    clients = [gClients copy];
  }
  for (CMClient *client in clients) {
    if (client.authed && client.screen) sendTo(client, message, binary, droppable);
  }
}

// ─── Windows ─────────────────────────────────────────────────────────────────

/** The app's own windows people use (no panels, menus, tooltips). */
static NSArray<NSWindow *> *appWindows(void) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSWindow *window in NSApp.windows) {
    if ([window isKindOfClass:[NSPanel class]] || !window.canBecomeMainWindow) continue;
    if (!window.isVisible && !window.isMiniaturized) continue;
    [out addObject:window];
  }
  return out;
}

static NSInteger gPinned = -1;

/** The window being watched: the one asked for, else the key one, else the first. */
static NSWindow *watchedWindow(void) {
  NSArray<NSWindow *> *windows = appWindows();
  for (NSWindow *window in windows) {
    if (window.windowNumber == gPinned) return window;
  }
  for (NSWindow *window in windows) {
    if (window.isKeyWindow) return window;
  }
  return windows.firstObject;
}

/** Height of the title bar above the content, in points (0 when the content runs under it). */
static CGFloat titleBarOf(NSWindow *window) {
  NSRect frame = window.frame;
  NSRect content = [window contentRectForFrameRect:frame];
  if (window.styleMask & NSWindowStyleMaskFullSizeContentView) return 0;
  return MAX(0, frame.size.height - content.size.height);
}

static NSDictionary *windowInfo(NSWindow *window) {
  NSSize size = window.contentView.bounds.size;
  NSAppearanceName dark = [window.effectiveAppearance bestMatchFromAppearancesWithNames:@[ NSAppearanceNameAqua, NSAppearanceNameDarkAqua ]];
  return @{
    @"id": @(window.windowNumber),
    @"title": window.title ?: @"",
    @"width": @(round(size.width)),
    @"height": @(round(size.height)),
    @"scale": @(window.backingScaleFactor ?: 2),
    @"focused": @(window.isKeyWindow),
    @"visible": @(window.isVisible),
    @"minimized": @(window.isMiniaturized),
    @"titleBar": @(round(titleBarOf(window))),
    @"buttons": [NSNull null],
    @"url": @"",
    @"dark": @([dark isEqualToString:NSAppearanceNameDarkAqua]),
  };
}

static NSArray *windowsInfo(void) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSWindow *window in appWindows()) [out addObject:windowInfo(window)];
  return out;
}

// ─── Capture ─────────────────────────────────────────────────────────────────

static dispatch_queue_t gCaptureQueue;
static int gFps = 30;
static int gMaxSize = 1400;
static int gQuality = 72;
static BOOL gVideo = NO;
static int gBitrate = 4000000;
static atomic_bool gKeyframe = true;
static uint32_t gSeq = 0;
static NSString *gCodecSent = nil;

/** Someone watches the window (capture runs only then). */
static BOOL gWatching = NO;
/** The newest picture, to send again when a viewer needs a keyframe and the window does not change. */
static CVPixelBufferRef gLastPixels = NULL;

static VTCompressionSessionRef gEncoder = NULL;
static int gEncW = 0, gEncH = 0;

API_AVAILABLE(macos(14.4))
@interface CMCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic) CGWindowID window;
@property(nonatomic) size_t width;
@property(nonatomic) size_t height;
@end

static id gCapture = nil;

static uint64_t nowUs(void) {
  return (uint64_t)([[NSDate date] timeIntervalSince1970] * 1e6);
}

static void putHeader(uint8_t *message, uint8_t type, BOOL key, uint64_t us, uint32_t seq) {
  message[0] = type;
  message[1] = key ? 1 : 0;
  message[2] = 0;
  message[3] = 0;
  for (int i = 0; i < 8; i++) message[4 + i] = (uint8_t)(us >> (56 - 8 * i));
  message[12] = (uint8_t)(seq >> 24);
  message[13] = (uint8_t)(seq >> 16);
  message[14] = (uint8_t)(seq >> 8);
  message[15] = (uint8_t)seq;
}

static void sendCodec(NSString *codec, NSString *reason) {
  if ([gCodecSent isEqualToString:codec] && !reason) return;
  gCodecSent = codec;
  NSMutableDictionary *message = [@{ @"t": @"codec", @"codec": codec } mutableCopy];
  if (reason) message[@"reason"] = reason;
  broadcast(message, nil, NO);
}

static void encoderOutput(void *ref, void *frameRef, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
  if (status != noErr || !sample || !CMSampleBufferDataIsReady(sample)) return;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  BOOL key = YES;
  if (attachments && CFArrayGetCount(attachments) > 0) {
    CFDictionaryRef first = CFArrayGetValueAtIndex(attachments, 0);
    key = !CFDictionaryContainsKey(first, kCMSampleAttachmentKey_NotSync);
  }
  uint64_t us = nowUs();
  if (key) {
    // Every keyframe comes after its config: the size and the avcC record.
    CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    CFDictionaryRef atoms = format ? CMFormatDescriptionGetExtension(format, kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) : NULL;
    CFDataRef avcc = atoms ? CFDictionaryGetValue(atoms, CFSTR("avcC")) : NULL;
    if (avcc) {
      CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(format);
      NSMutableData *config = [NSMutableData dataWithLength:20 + CFDataGetLength(avcc)];
      uint8_t *bytes = config.mutableBytes;
      putHeader(bytes, 1, NO, us, gSeq);
      bytes[16] = (uint8_t)(dims.width >> 8);
      bytes[17] = (uint8_t)dims.width;
      bytes[18] = (uint8_t)(dims.height >> 8);
      bytes[19] = (uint8_t)dims.height;
      memcpy(bytes + 20, CFDataGetBytePtr(avcc), CFDataGetLength(avcc));
      broadcast(@{ @"t": @"video" }, config, NO);
    }
  }
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
  size_t length = block ? CMBlockBufferGetDataLength(block) : 0;
  if (!length) return;
  NSMutableData *message = [NSMutableData dataWithLength:16 + length];
  putHeader(message.mutableBytes, 2, key, us, ++gSeq);
  if (CMBlockBufferCopyDataBytes(block, 0, length, (uint8_t *)message.mutableBytes + 16) != kCMBlockBufferNoErr) return;
  broadcast(@{ @"t": @"video" }, message, !key);
}

static void dropEncoder(void) {
  if (!gEncoder) return;
  VTCompressionSessionCompleteFrames(gEncoder, kCMTimeInvalid);
  VTCompressionSessionInvalidate(gEncoder);
  CFRelease(gEncoder);
  gEncoder = NULL;
}

static BOOL ensureEncoder(int width, int height) {
  if (gEncoder && gEncW == width && gEncH == height) return YES;
  dropEncoder();
  OSStatus status = VTCompressionSessionCreate(NULL, width, height, kCMVideoCodecType_H264, NULL, NULL, NULL, encoderOutput, NULL, &gEncoder);
  if (status != noErr || !gEncoder) {
    gEncoder = NULL;
    return NO;
  }
  VTSessionSetProperty(gEncoder, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
  VTSessionSetProperty(gEncoder, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
  VTSessionSetProperty(gEncoder, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
  VTSessionSetProperty(gEncoder, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, (__bridge CFTypeRef) @(10));
  VTSessionSetProperty(gEncoder, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFTypeRef) @(gFps));
  VTSessionSetProperty(gEncoder, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFTypeRef) @(gBitrate));
  VTCompressionSessionPrepareToEncodeFrames(gEncoder);
  gEncW = width;
  gEncH = height;
  atomic_store(&gKeyframe, true);
  return YES;
}

/** A BGRA buffer's picture as an image (a copy: the buffer may change after). */
static CGImageRef imageOf(CVPixelBufferRef pixels) {
  CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
  size_t width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels), row = CVPixelBufferGetBytesPerRow(pixels);
  CFDataRef bytes = CFDataCreate(NULL, CVPixelBufferGetBaseAddress(pixels), (CFIndex)(row * height));
  CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
  if (!bytes) return NULL;
  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGDataProviderRef provider = CGDataProviderCreateWithCFData(bytes);
  CGImageRef image = provider ? CGImageCreate(width, height, 8, 32, row, space, kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider, NULL, false, kCGRenderingIntentDefault) : NULL;
  if (provider) CGDataProviderRelease(provider);
  CFRelease(bytes);
  CGColorSpaceRelease(space);
  return image;
}

static NSData *jpegOf(CVPixelBufferRef pixels, int quality) {
  CGImageRef image = imageOf(pixels);
  if (!image) return nil;
  NSMutableData *out = [NSMutableData data];
  CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)out, CFSTR("public.jpeg"), 1, NULL);
  NSDictionary *props = @{ (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(quality / 100.0) };
  CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)props);
  if (!CGImageDestinationFinalize(dest)) out = nil;
  CFRelease(dest);
  CGImageRelease(image);
  return out;
}

/**
 * One new picture of the watched window, on the capture queue: encoded as
 * H.264 for a video viewer, else sent as a JPEG to viewers with room for one.
 */
static void deliverPixels(CVPixelBufferRef pixels, CMTime time, CGWindowID window) {
  CVPixelBufferRetain(pixels);
  if (gLastPixels) CVPixelBufferRelease(gLastPixels);
  gLastPixels = pixels;
  if (gVideo) {
    int width = (int)CVPixelBufferGetWidth(pixels), height = (int)CVPixelBufferGetHeight(pixels);
    if (!ensureEncoder(width, height)) {
      gVideo = NO;
      sendCodec(@"jpeg", @"This Mac could not start its H.264 encoder.");
      return;
    }
    sendCodec(@"h264", nil);
    NSDictionary *options = atomic_exchange(&gKeyframe, false) ? @{ (__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES } : nil;
    VTCompressionSessionEncodeFrame(gEncoder, pixels, time, kCMTimeInvalid, (__bridge CFDictionaryRef)options, NULL, NULL);
    return;
  }
  sendCodec(@"jpeg", nil);
  NSArray *clients;
  @synchronized(gLock) {
    clients = [gClients copy];
  }
  BOOL wanted = NO;
  for (CMClient *client in clients) wanted |= client.authed && client.screen && client.inflight < 2;
  if (!wanted) return;
  NSData *jpeg = jpegOf(pixels, gQuality);
  if (!jpeg) return;
  NSDictionary *message = @{ @"t": @"frame", @"window": @(window), @"seq": @(++gSeq) };
  for (CMClient *client in clients) {
    if (!client.authed || !client.screen || client.inflight >= 2) continue;
    client.inflight += 1;
    sendTo(client, message, jpeg, NO);
  }
}

@implementation CMCapture
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
  if (attachments && CFArrayGetCount(attachments) > 0) {
    NSDictionary *info = (__bridge NSDictionary *)CFArrayGetValueAtIndex(attachments, 0);
    NSNumber *frameStatus = info[SCStreamFrameInfoStatus];
    // Idle frames repeat the last picture: nothing changed, nothing to send.
    if (frameStatus && frameStatus.integerValue != SCFrameStatusComplete) return;
  }
  CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
  if (pixels) deliverPixels(pixels, CMSampleBufferGetPresentationTimeStamp(sample), self.window);
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (gCapture == self) gCapture = nil;
  });
}
@end

/** The content of the window (below its title bar) at most `maxSize` pixels on its longest side, even sizes for H.264. */
static void fitSize(CGFloat w, CGFloat h, size_t *width, size_t *height) {
  CGFloat longest = MAX(w, h);
  if (longest > gMaxSize) {
    w = w * gMaxSize / longest;
    h = h * gMaxSize / longest;
  }
  *width = MAX(2, ((size_t)round(w)) & ~(size_t)1);
  *height = MAX(2, ((size_t)round(h)) & ~(size_t)1);
}

static void captureSize(NSWindow *window, size_t *width, size_t *height) {
  NSSize points = window.contentView.bounds.size;
  CGFloat scale = window.backingScaleFactor ?: 2;
  fitSize(points.width * scale, points.height * scale, width, height);
}

// ─── Flutter's own surfaces ──────────────────────────────────────────────────
//
// Flutter's Mac embedder renders each frame into an IOSurface and shows it as
// a layer's contents (FlutterSurfaceManager). Reading that surface gives the
// app's picture straight from the app: it works while the Mac is locked or
// the window is covered, which a screen capture does not.

static NSTimer *gSurfaceTimer = nil;
static IOSurfaceRef gLastSurface = NULL;
/** Counts the surfaces layers were given: a new count is a new frame (Flutter takes turns with a few surfaces). */
static atomic_uint gSurfaceGen = 0;
static unsigned gLastGen = 0;
/** A copy is on its way: the next frame waits for it rather than piling up. */
static atomic_bool gCopying = false;
// Used on the capture queue only.
static VTPixelTransferSessionRef gTransfer = NULL;
static CVPixelBufferPoolRef gPool = NULL, gFullPool = NULL;
static size_t gPoolW = 0, gPoolH = 0, gFullW = 0, gFullH = 0;
/** Flutter's 10-bit extended-range values (384 is 0.0, 894 is 1.0) as 8-bit ones. */
static uint8_t gXr8[1024];

/** The surface with Flutter's main picture in the window: the biggest IOSurface a layer of its content shows. */
static IOSurfaceRef flutterSurface(NSWindow *window) {
  CALayer *root = window.contentView.layer;
  if (!root) return NULL;
  NSMutableArray<CALayer *> *queue = [NSMutableArray arrayWithObject:root];
  IOSurfaceRef best = NULL;
  size_t bestArea = 0;
  while (queue.count) {
    CALayer *layer = queue.firstObject;
    [queue removeObjectAtIndex:0];
    id contents = layer.contents;
    if (contents && CFGetTypeID((__bridge CFTypeRef)contents) == IOSurfaceGetTypeID()) {
      IOSurfaceRef surface = (__bridge IOSurfaceRef)contents;
      size_t area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface);
      if (area > bestArea) {
        best = surface;
        bestArea = area;
      }
    }
    if (layer.sublayers) [queue addObjectsFromArray:layer.sublayers];
  }
  return best;
}

static CVPixelBufferRef newBuffer(size_t width, size_t height) {
  NSDictionary *attributes = @{ (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{} };
  CVPixelBufferRef buffer = NULL;
  CVPixelBufferCreate(NULL, width, height, kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attributes, &buffer);
  return buffer;
}

/** A BGRA buffer from a pool of one size (made again when the size changes). */
static CVPixelBufferRef pooled(CVPixelBufferPoolRef *pool, size_t *poolW, size_t *poolH, size_t width, size_t height) {
  if (!*pool || *poolW != width || *poolH != height) {
    if (*pool) CVPixelBufferPoolRelease(*pool);
    *pool = NULL;
    NSDictionary *attributes = @{
      (__bridge NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
      (__bridge NSString *)kCVPixelBufferWidthKey: @(width),
      (__bridge NSString *)kCVPixelBufferHeightKey: @(height),
      (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
    };
    CVPixelBufferPoolCreate(NULL, NULL, (__bridge CFDictionaryRef)attributes, pool);
    *poolW = width;
    *poolH = height;
  }
  CVPixelBufferRef buffer = NULL;
  if (*pool) CVPixelBufferPoolCreatePixelBuffer(NULL, *pool, &buffer);
  return buffer;
}

/**
 * A wide-gamut surface's picture as 8-bit BGRA. Flutter draws in wide gamut
 * on displays that show it: 10-bit extended-range BGRA, each value in the top
 * bits of a 16-bit word. Colors beyond sRGB are clipped.
 */
static BOOL convertWideGamut(IOSurfaceRef surface, CVPixelBufferRef out) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    for (int i = 0; i < 1024; i++) {
      int v = i - 384;
      gXr8[i] = v <= 0 ? 0 : v >= 510 ? 255 : (uint8_t)((v * 255 + 255) / 510);
    }
  });
  if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return NO;
  CVPixelBufferLockBaseAddress(out, 0);
  size_t width = MIN(IOSurfaceGetWidth(surface), CVPixelBufferGetWidth(out));
  size_t height = MIN(IOSurfaceGetHeight(surface), CVPixelBufferGetHeight(out));
  const uint8_t *src = IOSurfaceGetBaseAddress(surface);
  size_t srcRow = IOSurfaceGetBytesPerRow(surface);
  uint8_t *dst = CVPixelBufferGetBaseAddress(out);
  size_t dstRow = CVPixelBufferGetBytesPerRow(out);
  for (size_t y = 0; y < height; y++) {
    const uint16_t *s = (const uint16_t *)(src + y * srcRow);
    uint8_t *d = dst + y * dstRow;
    for (size_t x = 0; x < width; x++, s += 4, d += 4) {
      d[0] = gXr8[s[0] >> 6];
      d[1] = gXr8[s[1] >> 6];
      d[2] = gXr8[s[2] >> 6];
      d[3] = 255;
    }
  }
  CVPixelBufferUnlockBaseAddress(out, 0);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
  return YES;
}

/** The surface's picture as BGRA at its own size: an 8-bit surface as it is, a wide-gamut one converted. Retained, or NULL. */
static CVPixelBufferRef bgraOf(IOSurfaceRef surface, BOOL usePool) {
  OSType format = IOSurfaceGetPixelFormat(surface);
  size_t width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface);
  if (format == kCVPixelFormatType_32BGRA) {
    CVPixelBufferRef wrapped = NULL;
    CVPixelBufferCreateWithIOSurface(NULL, surface, NULL, &wrapped);
    return wrapped;
  }
  if (format != kCVPixelFormatType_40ARGBLEWideGamut && format != kCVPixelFormatType_40ARGBLEWideGamutPremultiplied) return NULL;
  CVPixelBufferRef out = usePool ? pooled(&gFullPool, &gFullW, &gFullH, width, height) : newBuffer(width, height);
  if (!out) return NULL;
  if (!convertWideGamut(surface, out)) {
    CVPixelBufferRelease(out);
    return NULL;
  }
  return out;
}

/**
 * A copy of the surface's picture at `width`×`height`, on the capture queue
 * (the surface is Flutter's: it draws a later frame into it once it is free).
 */
static CVPixelBufferRef copySurface(IOSurfaceRef surface, size_t width, size_t height, BOOL usePool) {
  CVPixelBufferRef source = bgraOf(surface, usePool);
  if (!source) return NULL;
  BOOL converted = IOSurfaceGetPixelFormat(surface) != kCVPixelFormatType_32BGRA;
  if (converted && CVPixelBufferGetWidth(source) == width && CVPixelBufferGetHeight(source) == height) return source;
  CVPixelBufferRef copy = usePool ? pooled(&gPool, &gPoolW, &gPoolH, width, height) : newBuffer(width, height);
  if (!gTransfer) {
    VTPixelTransferSessionCreate(NULL, &gTransfer);
    if (gTransfer) VTSessionSetProperty(gTransfer, kVTPixelTransferPropertyKey_ScalingMode, kVTScalingMode_Normal);
  }
  BOOL ok = copy && gTransfer && VTPixelTransferSessionTransferImage(gTransfer, source, copy) == noErr;
  CVPixelBufferRelease(source);
  if (!ok) {
    if (copy) CVPixelBufferRelease(copy);
    return NULL;
  }
  return copy;
}

/** Looks for a new Flutter frame, `fps` times a second while someone watches; on the main thread, as Flutter shows its frames. */
static void pollSurface(void) {
  if (atomic_load(&gCopying)) return;
  NSWindow *window = watchedWindow();
  IOSurfaceRef surface = window ? flutterSurface(window) : NULL;
  if (!surface) return;
  unsigned gen = atomic_load(&gSurfaceGen);
  BOOL wantsKey = gVideo && atomic_load(&gKeyframe);
  if (surface == gLastSurface && gen == gLastGen && !wantsKey) return;
  gLastSurface = surface;
  gLastGen = gen;
  // While the surface is in use, Flutter draws its next frames into others.
  CFRetain(surface);
  IOSurfaceIncrementUseCount(surface);
  atomic_store(&gCopying, true);
  CGWindowID windowId = (CGWindowID)window.windowNumber;
  CMTime time = CMClockGetTime(CMClockGetHostTimeClock());
  dispatch_async(gCaptureQueue, ^{
    size_t width, height;
    fitSize(IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface), &width, &height);
    CVPixelBufferRef copy = copySurface(surface, width, height, YES);
    IOSurfaceDecrementUseCount(surface);
    CFRelease(surface);
    if (copy) {
      deliverPixels(copy, time, windowId);
      CVPixelBufferRelease(copy);
    }
    atomic_store(&gCopying, false);
  });
}

static IOPMAssertionID gAwake = 0;
static id<NSObject> gActivity = nil;

/**
 * While someone watches, the app keeps drawing at full speed: no App Nap for
 * a window nobody on the Mac looks at, and the display stays on (Flutter
 * draws on the display's beat).
 */
static void keepAwake(BOOL on) {
  if (on && !gAwake) {
    IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep, kIOPMAssertionLevelOn, CFSTR("CapMac shows this app's window on a PC"), &gAwake);
  } else if (!on && gAwake) {
    IOPMAssertionRelease(gAwake);
    gAwake = 0;
  }
  if (on && !gActivity) {
    gActivity = [NSProcessInfo.processInfo beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical reason:@"CapMac shows this app's window on a PC"];
  } else if (!on && gActivity) {
    [NSProcessInfo.processInfo endActivity:gActivity];
    gActivity = nil;
  }
}

/** Sends the newest picture again (a keyframe for video), on the capture queue. */
static void resendLast(void) {
  dispatch_async(gCaptureQueue, ^{
    CVPixelBufferRef pixels = gLastPixels;
    if (!pixels) return;
    if (gVideo && gEncoder) {
      NSDictionary *options = @{ (__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES };
      atomic_store(&gKeyframe, false);
      VTCompressionSessionEncodeFrame(gEncoder, pixels, CMClockGetTime(CMClockGetHostTimeClock()), kCMTimeInvalid, (__bridge CFDictionaryRef)options, NULL, NULL);
    }
  });
}

static void stopCapture(void) {
  [gSurfaceTimer invalidate];
  gSurfaceTimer = nil;
  gLastSurface = NULL;
  if (@available(macOS 14.4, *)) {
    CMCapture *capture = gCapture;
    gCapture = nil;
    if (capture.stream) [capture.stream stopCaptureWithCompletionHandler:^(NSError *error) {}];
  }
  keepAwake(NO);
  dispatch_async(gCaptureQueue, ^{
    dropEncoder();
  });
}

/** A screen capture of the window (ScreenCaptureKit, own windows): for windows Flutter does not draw. */
static void startScreenCapture(NSWindow *window) {
  if (@available(macOS 14.4, *)) {
    size_t width, height;
    captureSize(window, &width, &height);
    CMCapture *current = gCapture;
    if (current && current.window == window.windowNumber && current.width == width && current.height == height) return;
    if (current.stream) [current.stream stopCaptureWithCompletionHandler:^(NSError *error) {}];
    gCapture = nil;
    CGWindowID windowId = (CGWindowID)window.windowNumber;
    CGFloat titleBar = titleBarOf(window);
    NSSize points = window.contentView.bounds.size;
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
      SCWindow *target = nil;
      for (SCWindow *candidate in content.windows) {
        if (candidate.windowID == windowId) target = candidate;
      }
      if (!target) {
        markLine(@{ @"e": @"note", @"message": [NSString stringWithFormat:@"CapMac could not capture the window: %@", error.localizedDescription ?: @"not shareable"] });
        return;
      }
      SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
      SCStreamConfiguration *config = [SCStreamConfiguration new];
      config.width = width;
      config.height = height;
      // Only the content, as the Electron module sends a page: CapMac Studio draws the title bar itself.
      config.sourceRect = CGRectMake(0, titleBar, points.width, points.height);
      config.minimumFrameInterval = CMTimeMake(1, MAX(1, gFps));
      config.pixelFormat = kCVPixelFormatType_32BGRA;
      config.showsCursor = NO;
      config.queueDepth = 4;
      if (@available(macOS 14.0, *)) config.ignoreShadowsSingleWindow = YES;
      CMCapture *capture = [CMCapture new];
      capture.window = windowId;
      capture.width = width;
      capture.height = height;
      capture.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:capture];
      NSError *addError = nil;
      if (![capture.stream addStreamOutput:capture type:SCStreamOutputTypeScreen sampleHandlerQueue:gCaptureQueue error:&addError]) {
        markLine(@{ @"e": @"note", @"message": [NSString stringWithFormat:@"CapMac could not capture the window: %@", addError.localizedDescription] });
        return;
      }
      atomic_store(&gKeyframe, true);
      [capture.stream startCaptureWithCompletionHandler:^(NSError *startError) {
        if (startError) markLine(@{ @"e": @"note", @"message": [NSString stringWithFormat:@"CapMac could not capture the window (is the Mac locked?): %@", startError.localizedDescription] });
      }];
      dispatch_async(dispatch_get_main_queue(), ^{
        gCapture = capture;
      });
    }];
  } else {
    sendCodec(@"jpeg", @"Showing this Mac app’s window needs macOS 14.4 or later.");
  }
}

/** Starts (or retargets) the capture of the watched window; on the main thread. */
static void startCapture(void) {
  if (!gWatching) return;
  NSWindow *window = watchedWindow();
  if (!window) {
    stopCapture();
    return;
  }
  keepAwake(YES);
  if (flutterSurface(window)) {
    // Flutter draws this window: read its frames (a timer keeps looking for new ones).
    if (!gSurfaceTimer) {
      gSurfaceTimer = [NSTimer timerWithTimeInterval:1.0 / MAX(1, gFps) repeats:YES block:^(NSTimer *timer) {
        pollSurface();
      }];
      [NSRunLoop.mainRunLoop addTimer:gSurfaceTimer forMode:NSRunLoopCommonModes];
    }
    gLastSurface = NULL;
    pollSurface();
    return;
  }
  startScreenCapture(window);
}

static void sendPng(CMClient *client, NSInteger requestId, CGImageRef image) {
  NSMutableData *png = [NSMutableData data];
  CGImageDestinationRef dest = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png, CFSTR("public.png"), 1, NULL);
  CGImageDestinationAddImage(dest, image, NULL);
  BOOL ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  if (!ok) {
    sendTo(client, @{ @"t": @"result", @"id": @(requestId), @"ok": @NO, @"error": @"No picture." }, nil, NO);
    return;
  }
  sendTo(client, @{ @"t": @"screenshot", @"id": @(requestId), @"width": @(CGImageGetWidth(image)), @"height": @(CGImageGetHeight(image)) }, png, NO);
}

static void screenshot(CMClient *client, NSInteger requestId) {
  NSWindow *window = watchedWindow();
  IOSurfaceRef surface = window ? flutterSurface(window) : NULL;
  if (surface) {
    // Flutter's own picture, at full size (as the stream's frames are read).
    CFRetain(surface);
    IOSurfaceIncrementUseCount(surface);
    dispatch_async(gCaptureQueue, ^{
      CVPixelBufferRef copy = copySurface(surface, IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface), NO);
      IOSurfaceDecrementUseCount(surface);
      CFRelease(surface);
      CGImageRef image = copy ? imageOf(copy) : NULL;
      if (copy) CVPixelBufferRelease(copy);
      if (!image) {
        sendTo(client, @{ @"t": @"result", @"id": @(requestId), @"ok": @NO, @"error": @"CapMac could not read the app’s picture." }, nil, NO);
        return;
      }
      sendPng(client, requestId, image);
      CGImageRelease(image);
    });
    return;
  }
  if (@available(macOS 14.4, *)) {
    if (!window) {
      sendTo(client, @{ @"t": @"result", @"id": @(requestId), @"ok": @NO, @"error": @"The app has no window." }, nil, NO);
      return;
    }
    CGWindowID windowId = (CGWindowID)window.windowNumber;
    CGFloat titleBar = titleBarOf(window);
    NSSize points = window.contentView.bounds.size;
    CGFloat scale = window.backingScaleFactor ?: 2;
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
      SCWindow *target = nil;
      for (SCWindow *candidate in content.windows) {
        if (candidate.windowID == windowId) target = candidate;
      }
      if (!target) {
        sendTo(client, @{ @"t": @"result", @"id": @(requestId), @"ok": @NO, @"error": error.localizedDescription ?: @"The window is not shareable." }, nil, NO);
        return;
      }
      SCStreamConfiguration *config = [SCStreamConfiguration new];
      config.width = (size_t)(points.width * scale);
      config.height = (size_t)(points.height * scale);
      config.sourceRect = CGRectMake(0, titleBar, points.width, points.height);
      config.showsCursor = NO;
      if (@available(macOS 14.0, *)) config.ignoreShadowsSingleWindow = YES;
      SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
      [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef image, NSError *shotError) {
        if (!image) {
          sendTo(client, @{ @"t": @"result", @"id": @(requestId), @"ok": @NO, @"error": shotError.localizedDescription ?: @"No picture." }, nil, NO);
          return;
        }
        sendPng(client, requestId, image);
      }];
    }];
  } else {
    sendTo(client, @{ @"t": @"result", @"id": @(requestId), @"ok": @NO, @"error": @"Needs macOS 14.4 or later." }, nil, NO);
  }
}

// ─── Input ───────────────────────────────────────────────────────────────────

static NSEventModifierFlags modifierFlags(NSDictionary *event) {
  long bits = [event[@"modifiers"] longValue];
  NSEventModifierFlags flags = 0;
  if (bits & 1) flags |= NSEventModifierFlagShift;
  if (bits & 2) flags |= NSEventModifierFlagControl;
  if (bits & 4) flags |= NSEventModifierFlagOption;
  if (bits & 8) flags |= NSEventModifierFlagCommand;
  return flags;
}

static NSInteger gEventNumber = 0;

/** A point of the window's content (0 to 1 from its top left) in the window's coordinates. */
static NSPoint pointIn(NSWindow *window, NSDictionary *event) {
  NSRect content = [window.contentView convertRect:window.contentView.bounds toView:nil];
  double x = [event[@"x"] doubleValue], y = [event[@"y"] doubleValue];
  return NSMakePoint(NSMinX(content) + x * NSWidth(content), NSMinY(content) + (1 - y) * NSHeight(content));
}

static void injectMouse(NSWindow *window, NSDictionary *event) {
  NSString *phase = event[@"phase"];
  NSString *button = event[@"button"] ?: @"left";
  long buttons = [event[@"buttons"] longValue];
  NSPoint location = pointIn(window, event);
  NSEventType type;
  if ([phase isEqualToString:@"down"]) {
    type = [button isEqualToString:@"right"] ? NSEventTypeRightMouseDown : [button isEqualToString:@"middle"] ? NSEventTypeOtherMouseDown : NSEventTypeLeftMouseDown;
  } else if ([phase isEqualToString:@"up"]) {
    type = [button isEqualToString:@"right"] ? NSEventTypeRightMouseUp : [button isEqualToString:@"middle"] ? NSEventTypeOtherMouseUp : NSEventTypeLeftMouseUp;
  } else if ([phase isEqualToString:@"move"]) {
    type = (buttons & 1) ? NSEventTypeLeftMouseDragged : (buttons & 2) ? NSEventTypeRightMouseDragged : (buttons & 4) ? NSEventTypeOtherMouseDragged : NSEventTypeMouseMoved;
  } else {
    return;
  }
  BOOL press = type == NSEventTypeLeftMouseDown || type == NSEventTypeRightMouseDown || type == NSEventTypeOtherMouseDown || type == NSEventTypeLeftMouseDragged;
  NSInteger clicks = MAX(1, [event[@"clicks"] integerValue]);
  NSEvent *ns = [NSEvent mouseEventWithType:type location:location modifierFlags:modifierFlags(event) timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:++gEventNumber clickCount:(type == NSEventTypeMouseMoved ? 0 : clicks) pressure:press ? 1.0 : 0.0];
  if (ns) [window sendEvent:ns];
}

static void injectWheel(NSWindow *window, NSDictionary *event) {
  NSPoint location = pointIn(window, event);
  CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
  // CapMac's deltas are positive down and right; a wheel's are positive up and left.
  int32_t dy = (int32_t)lround(-[event[@"dy"] doubleValue]);
  int32_t dx = (int32_t)lround(-[event[@"dx"] doubleValue]);
  CGEventRef cg = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2, dy, dx, 0);
  if (!cg) return;
  // An NSEvent made from a CGEvent has no window, so its locationInWindow is
  // the CGEvent's location: put the point in the window there.
  CGEventSetLocation(cg, CGPointMake(location.x, top - location.y));
  CGEventSetFlags(cg, (CGEventFlags)modifierFlags(event));
  NSEvent *ns = [NSEvent eventWithCGEvent:cg];
  CFRelease(cg);
  if (ns) [window sendEvent:ns];
}

/** macOS key codes by the DOM `code` of the PC's keyboard. */
static NSDictionary<NSString *, NSNumber *> *keyCodes(void) {
  static NSDictionary *codes;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    codes = @{
      @"KeyA": @0, @"KeyS": @1, @"KeyD": @2, @"KeyF": @3, @"KeyH": @4, @"KeyG": @5, @"KeyZ": @6, @"KeyX": @7, @"KeyC": @8, @"KeyV": @9,
      @"KeyB": @11, @"KeyQ": @12, @"KeyW": @13, @"KeyE": @14, @"KeyR": @15, @"KeyY": @16, @"KeyT": @17, @"Digit1": @18, @"Digit2": @19,
      @"Digit3": @20, @"Digit4": @21, @"Digit6": @22, @"Digit5": @23, @"Equal": @24, @"Digit9": @25, @"Digit7": @26, @"Minus": @27,
      @"Digit8": @28, @"Digit0": @29, @"BracketRight": @30, @"KeyO": @31, @"KeyU": @32, @"BracketLeft": @33, @"KeyI": @34, @"KeyP": @35,
      @"Enter": @36, @"KeyL": @37, @"KeyJ": @38, @"Quote": @39, @"KeyK": @40, @"Semicolon": @41, @"Backslash": @42, @"Comma": @43,
      @"Slash": @44, @"KeyN": @45, @"KeyM": @46, @"Period": @47, @"Tab": @48, @"Space": @49, @"Backquote": @50, @"Backspace": @51,
      @"Escape": @53, @"MetaRight": @54, @"MetaLeft": @55, @"ShiftLeft": @56, @"CapsLock": @57, @"AltLeft": @58, @"ControlLeft": @59,
      @"ShiftRight": @60, @"AltRight": @61, @"ControlRight": @62, @"F17": @64, @"NumpadDecimal": @65, @"NumpadMultiply": @67,
      @"NumpadAdd": @69, @"NumpadDivide": @75, @"NumpadEnter": @76, @"NumpadSubtract": @78, @"NumpadEqual": @81, @"Numpad0": @82,
      @"Numpad1": @83, @"Numpad2": @84, @"Numpad3": @85, @"Numpad4": @86, @"Numpad5": @87, @"Numpad6": @88, @"Numpad7": @89,
      @"Numpad8": @91, @"Numpad9": @92, @"F5": @96, @"F6": @97, @"F7": @98, @"F3": @99, @"F8": @100, @"F9": @101, @"F11": @103,
      @"F13": @105, @"F14": @107, @"F10": @109, @"F12": @111, @"F15": @113, @"Insert": @114, @"Home": @115, @"PageUp": @116,
      @"Delete": @117, @"F4": @118, @"End": @119, @"F2": @120, @"PageDown": @121, @"F1": @122, @"ArrowLeft": @123, @"ArrowRight": @124,
      @"ArrowDown": @125, @"ArrowUp": @126,
    };
  });
  return codes;
}

/** The characters a key types, as AppKit gives them (function keys use AppKit's private range). */
static NSString *charactersFor(NSString *key) {
  static NSDictionary *special;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    unichar up = NSUpArrowFunctionKey, down = NSDownArrowFunctionKey, left = NSLeftArrowFunctionKey, right = NSRightArrowFunctionKey;
    unichar home = NSHomeFunctionKey, end = NSEndFunctionKey, pageUp = NSPageUpFunctionKey, pageDown = NSPageDownFunctionKey, del = NSDeleteFunctionKey;
    special = @{
      @"Enter": @"\r", @"Tab": @"\t", @"Backspace": @"\x7f", @"Escape": @"\x1b", @" ": @" ",
      @"ArrowUp": [NSString stringWithCharacters:&up length:1], @"ArrowDown": [NSString stringWithCharacters:&down length:1],
      @"ArrowLeft": [NSString stringWithCharacters:&left length:1], @"ArrowRight": [NSString stringWithCharacters:&right length:1],
      @"Home": [NSString stringWithCharacters:&home length:1], @"End": [NSString stringWithCharacters:&end length:1],
      @"PageUp": [NSString stringWithCharacters:&pageUp length:1], @"PageDown": [NSString stringWithCharacters:&pageDown length:1],
      @"Delete": [NSString stringWithCharacters:&del length:1],
    };
  });
  if (special[key]) return special[key];
  if (key.length >= 1 && key.length <= 2) return key;
  return @"";
}

static const NSInteger MODIFIER_KEYS[] = {54, 55, 56, 57, 58, 59, 60, 61, 62};

static void injectKey(NSWindow *window, NSDictionary *event) {
  NSString *code = event[@"code"] ?: @"";
  NSString *key = event[@"key"] ?: @"";
  NSNumber *keyCode = keyCodes()[code];
  BOOL down = [event[@"phase"] isEqualToString:@"down"];
  NSEventModifierFlags flags = modifierFlags(event);
  unsigned short vk = keyCode ? keyCode.unsignedShortValue : 0;
  for (size_t i = 0; i < sizeof(MODIFIER_KEYS) / sizeof(MODIFIER_KEYS[0]); i++) {
    if (keyCode && vk == MODIFIER_KEYS[i]) {
      // Modifier keys alone are flag changes to AppKit.
      NSEvent *ns = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@"" isARepeat:NO keyCode:vk];
      if (ns) [window sendEvent:ns];
      return;
    }
  }
  NSString *characters = charactersFor(key);
  NSString *ignoring = characters.lowercaseString;
  NSEvent *ns = [NSEvent keyEventWithType:down ? NSEventTypeKeyDown : NSEventTypeKeyUp location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:characters charactersIgnoringModifiers:ignoring isARepeat:[event[@"repeat"] boolValue] keyCode:vk];
  if (!ns) return;
  // ⌘ shortcuts go through the app's menu first (Copy, Paste, Select All, Quit…), as AppKit does.
  if (down && (flags & NSEventModifierFlagCommand) && [NSApp.mainMenu performKeyEquivalent:ns]) return;
  [window sendEvent:ns];
}

static void injectText(NSWindow *window, NSDictionary *event) {
  NSString *text = event[@"text"] ?: @"";
  if (!text.length) return;
  if ([event[@"via"] isEqualToString:@"paste"]) {
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    [board clearContents];
    [board setString:text forType:NSPasteboardTypeString];
    injectKey(window, @{ @"phase": @"down", @"code": @"KeyV", @"key": @"v", @"modifiers": @8 });
    injectKey(window, @{ @"phase": @"up", @"code": @"KeyV", @"key": @"v", @"modifiers": @8 });
    return;
  }
  id responder = window.firstResponder;
  if ([responder conformsToProtocol:@protocol(NSTextInputClient)]) {
    [(id<NSTextInputClient>)responder insertText:text replacementRange:NSMakeRange(NSNotFound, 0)];
    return;
  }
  // No text field has the keyboard: type it as keys.
  [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences usingBlock:^(NSString *character, NSRange range, NSRange enclosing, BOOL *stop) {
    const NSEventType types[] = {NSEventTypeKeyDown, NSEventTypeKeyUp};
    for (int i = 0; i < 2; i++) {
      NSEvent *ns = [NSEvent keyEventWithType:types[i] location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:character charactersIgnoringModifiers:character isARepeat:NO keyCode:0];
      if (ns) [window sendEvent:ns];
    }
  }];
}

static void injectInput(NSDictionary *event) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = watchedWindow();
    if (!window) return;
    if (window.firstResponder == window && window.contentView.acceptsFirstResponder) [window makeFirstResponder:window.contentView];
    NSString *kind = event[@"kind"];
    if ([kind isEqualToString:@"mouse"]) injectMouse(window, event);
    else if ([kind isEqualToString:@"wheel"]) injectWheel(window, event);
    else if ([kind isEqualToString:@"keyboard"]) injectKey(window, event);
    else if ([kind isEqualToString:@"text"]) injectText(window, event);
  });
}

// ─── Requests ────────────────────────────────────────────────────────────────

static void handle(CMClient *client, NSDictionary *request) {
  NSString *t = request[@"t"];
  if (!client.authed) {
    if ([t isEqualToString:@"auth"] && [request[@"token"] isEqual:gToken]) {
      client.authed = YES;
    } else {
      shutdown(client.fd, SHUT_RDWR);
    }
    return;
  }
  if ([t isEqualToString:@"hello"]) {
    client.screen = [request[@"role"] isEqualToString:@"screen"];
    dispatch_async(dispatch_get_main_queue(), ^{
      NSDictionary *app = @{
        @"pid": @(getpid()), @"name": NSRunningApplication.currentApplication.localizedName ?: @"", @"electron": @"", @"chrome": @"", @"node": @"",
        @"socket": [NSString stringWithFormat:@"tcp:127.0.0.1:%d", gPort], @"dialogs": [NSNull null], @"sound": @"mac", @"soundToPc": @NO, @"h264": @YES, @"native": @YES,
      };
      sendTo(client, @{ @"t": @"hello", @"app": app, @"windows": windowsInfo() }, nil, NO);
    });
  } else if ([t isEqualToString:@"watch"]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      gPinned = [request[@"window"] isKindOfClass:[NSNumber class]] ? [request[@"window"] integerValue] : -1;
      gMaxSize = MAX(320, MIN(4096, [request[@"maxSize"] intValue] ?: 1400));
      gFps = MAX(1, MIN(60, [request[@"fps"] intValue] ?: 30));
      gQuality = MAX(30, MIN(95, [request[@"quality"] intValue] ?: 72));
      if ([request[@"bitrate"] intValue] > 0) gBitrate = [request[@"bitrate"] intValue];
      gVideo = [request[@"codec"] isEqualToString:@"h264"];
      gCodecSent = nil;
      sendCodec(gVideo ? @"h264" : @"jpeg", nil);
      sendTo(client, @{ @"t": @"windows", @"windows": windowsInfo(), @"watched": @(watchedWindow().windowNumber) }, nil, NO);
      // A new watcher (or new settings) starts from a fresh picture: a new capture sends one at once.
      gWatching = YES;
      stopCapture();
      startCapture();
    });
  } else if ([t isEqualToString:@"ack"]) {
    if (client.inflight > 0) client.inflight -= 1;
  } else if ([t isEqualToString:@"keyframe"]) {
    atomic_store(&gKeyframe, true);
    resendLast();
  } else if ([t isEqualToString:@"bitrate"]) {
    int bitrate = [request[@"bitrate"] intValue];
    dispatch_async(gCaptureQueue, ^{
      if (bitrate <= 0) return;
      gBitrate = bitrate;
      if (gEncoder) VTSessionSetProperty(gEncoder, kVTCompressionPropertyKey_AverageBitRate, (__bridge CFTypeRef) @(bitrate));
    });
  } else if ([t isEqualToString:@"retry-video"]) {
    dispatch_async(gCaptureQueue, ^{
      dropEncoder();
    });
  } else if ([t isEqualToString:@"input"]) {
    if ([request[@"event"] isKindOfClass:[NSDictionary class]]) injectInput(request[@"event"]);
  } else if ([t isEqualToString:@"window-action"]) {
    NSInteger number = [request[@"window"] integerValue];
    NSString *action = request[@"action"];
    dispatch_async(dispatch_get_main_queue(), ^{
      for (NSWindow *window in appWindows()) {
        if (window.windowNumber != number) continue;
        if ([action isEqualToString:@"close"]) [window performClose:nil];
        else if ([action isEqualToString:@"minimize"]) [window miniaturize:nil];
        else if ([action isEqualToString:@"zoom"]) [window zoom:nil];
      }
    });
  } else if ([t isEqualToString:@"screenshot"]) {
    NSInteger requestId = [request[@"id"] integerValue];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (request[@"window"]) gPinned = [request[@"window"] integerValue];
      screenshot(client, requestId);
    });
  } else if ([t isEqualToString:@"ping"]) {
    sendTo(client, @{ @"t": @"pong", @"id": request[@"id"] ?: @0 }, nil, NO);
  } else if ([t isEqualToString:@"reload"] || [t isEqualToString:@"modules"] || [t isEqualToString:@"sound"]) {
    // Electron-only requests: a native app has no pages to reload, nor modules, nor CapMac-routed sound.
    if (request[@"id"]) sendTo(client, @{ @"t": @"result", @"id": request[@"id"], @"ok": @NO, @"error": @"Not for this app." }, nil, NO);
  }
}

static BOOL readAll(int fd, void *buffer, size_t length) {
  uint8_t *bytes = buffer;
  while (length > 0) {
    ssize_t n = recv(fd, bytes, length, 0);
    if (n <= 0) return NO;
    bytes += n;
    length -= (size_t)n;
  }
  return YES;
}

static void *clientLoop(void *arg) {
  CMClient *client = (__bridge_transfer CMClient *)arg;
  @autoreleasepool {
    for (;;) {
      uint32_t length;
      if (!readAll(client.fd, &length, 4)) break;
      length = ntohl(length);
      if (length < 1 || length > 16 * 1024 * 1024) break;
      NSMutableData *body = [NSMutableData dataWithLength:length];
      if (!readAll(client.fd, body.mutableBytes, length)) break;
      if (((uint8_t *)body.bytes)[0] != 0) continue;
      NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[body subdataWithRange:NSMakeRange(1, length - 1)] options:0 error:nil];
      if ([request isKindOfClass:[NSDictionary class]]) handle(client, request);
      if (!client.authed && ![request[@"t"] isEqualToString:@"auth"]) break;
    }
  }
  close(client.fd);
  @synchronized(gLock) {
    [gClients removeObject:client];
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    BOOL watched = NO;
    @synchronized(gLock) {
      for (CMClient *other in gClients) watched |= other.screen;
    }
    if (!watched) {
      gWatching = NO;
      stopCapture();
    }
  });
  return NULL;
}

static void *serverLoop(void *arg) {
  for (;;) {
    int fd = accept(gServer, NULL, NULL);
    if (fd < 0) continue;
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    CMClient *client = [CMClient new];
    client.fd = fd;
    client.writes = dispatch_queue_create("dev.capmac.apphook.write", DISPATCH_QUEUE_SERIAL);
    @synchronized(gLock) {
      [gClients addObject:client];
    }
    pthread_t thread;
    pthread_create(&thread, NULL, clientLoop, (__bridge_retained void *)client);
    pthread_detach(thread);
  }
  return NULL;
}

static BOOL listenOn(int port) {
  gServer = socket(AF_INET, SOCK_STREAM, 0);
  if (gServer < 0) return NO;
  int one = 1;
  setsockopt(gServer, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(gServer, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(gServer, 8) != 0) {
    close(gServer);
    gServer = -1;
    return NO;
  }
  pthread_t thread;
  pthread_create(&thread, NULL, serverLoop, NULL);
  pthread_detach(thread);
  return YES;
}

// ─── Lines on stdout for the agent (HOOK_MARK + JSON, as the Electron module writes) ──

static void markLine(NSDictionary *event) {
  NSMutableData *line = [NSMutableData dataWithBytes:"\xE2\x81\xA3" "e" "\xE2\x81\xA3" length:7];
  [line appendData:json(event)];
  [line appendBytes:"\n" length:1];
  write(STDOUT_FILENO, line.bytes, line.length);
}

static void sendWindows(void) {
  NSArray *windows = windowsInfo();
  NSWindow *watched = watchedWindow();
  broadcast(@{ @"t": @"windows", @"windows": windows, @"watched": watched ? @(watched.windowNumber) : [NSNull null] }, nil, NO);
  for (NSDictionary *info in windows) markLine(@{ @"e": @"window", @"window": info });
  if (watched) startCapture();
}

// ─── Focus guard ─────────────────────────────────────────────────────────────

/** In the background: not the active app. Someone who clicks it on the Mac makes it active, and then it behaves as usual. */
static BOOL inBackground(void) {
  return !NSApp.isActive;
}

static IMP originalActivate, originalActivateIgnoring, originalOrderFront, originalMakeKeyAndOrderFront, originalOrderFrontRegardless, originalRequestAttention, originalRunningActivate, originalSetString, originalCursorSet;

static void guardedActivateIgnoring(id self, SEL _cmd, BOOL flag) {
  if (inBackground()) return;
  ((void (*)(id, SEL, BOOL))originalActivateIgnoring)(self, _cmd, flag);
}

static void guardedActivate(id self, SEL _cmd) {
  if (inBackground()) return;
  ((void (*)(id, SEL))originalActivate)(self, _cmd);
}

static BOOL guardedRunningActivate(NSRunningApplication *self, SEL _cmd, NSApplicationActivationOptions options) {
  if (self.processIdentifier == getpid() && inBackground()) return NO;
  return ((BOOL (*)(id, SEL, NSApplicationActivationOptions))originalRunningActivate)(self, _cmd, options);
}

/** A window that wants to come forward goes behind the others instead (still on screen, so it can be captured). */
static void orderBehind(NSWindow *window) {
  [window orderWindow:NSWindowBelow relativeTo:0];
}

static void guardedOrderFront(NSWindow *self, SEL _cmd, id sender) {
  if (inBackground() && ![self isKindOfClass:[NSPanel class]]) return orderBehind(self);
  ((void (*)(id, SEL, id))originalOrderFront)(self, _cmd, sender);
}

static void guardedMakeKeyAndOrderFront(NSWindow *self, SEL _cmd, id sender) {
  if (inBackground() && ![self isKindOfClass:[NSPanel class]]) {
    orderBehind(self);
    [self makeKeyWindow];
    return;
  }
  ((void (*)(id, SEL, id))originalMakeKeyAndOrderFront)(self, _cmd, sender);
}

static void guardedOrderFrontRegardless(NSWindow *self, SEL _cmd) {
  if (inBackground()) return orderBehind(self);
  ((void (*)(id, SEL))originalOrderFrontRegardless)(self, _cmd);
}

static NSInteger guardedRequestAttention(id self, SEL _cmd, NSRequestUserAttentionType type) {
  if (inBackground()) return 0;
  return ((NSInteger (*)(id, SEL, NSRequestUserAttentionType))originalRequestAttention)(self, _cmd, type);
}

/** Text the app copies goes to the PC's clipboard too (the general pasteboard only, and only what this app writes). */
static BOOL watchedSetString(NSPasteboard *self, SEL _cmd, NSString *string, NSPasteboardType type) {
  BOOL ok = ((BOOL (*)(id, SEL, NSString *, NSPasteboardType))originalSetString)(self, _cmd, string, type);
  if (ok && string && [self.name isEqualToString:NSPasteboardNameGeneral] && [type isEqualToString:NSPasteboardTypeString]) broadcast(@{ @"t": @"clipboard", @"text": string }, nil, NO);
  return ok;
}

static NSString *gCursorSent = nil;

static void watchedCursorSet(NSCursor *self, SEL _cmd) {
  ((void (*)(id, SEL))originalCursorSet)(self, _cmd);
  NSString *name = self == NSCursor.pointingHandCursor ? @"hand" : self == NSCursor.IBeamCursor ? @"text" : self == NSCursor.crosshairCursor ? @"crosshair"
    : self == NSCursor.openHandCursor ? @"grab" : self == NSCursor.closedHandCursor ? @"grabbing" : self == NSCursor.operationNotAllowedCursor ? @"not-allowed"
    : self == NSCursor.resizeLeftRightCursor ? @"ew-resize" : self == NSCursor.resizeUpDownCursor ? @"ns-resize" : @"pointer";
  if ([name isEqualToString:gCursorSent]) return;
  gCursorSent = name;
  broadcast(@{ @"t": @"cursor", @"cursor": name }, nil, NO);
}

static IMP originalSetContents;

static void watchedSetContents(CALayer *self, SEL _cmd, id contents) {
  ((void (*)(id, SEL, id))originalSetContents)(self, _cmd, contents);
  if (contents && CFGetTypeID((__bridge CFTypeRef)contents) == IOSurfaceGetTypeID()) atomic_fetch_add(&gSurfaceGen, 1);
}

static IMP swap(Class cls, SEL selector, IMP replacement) {
  Method method = class_getInstanceMethod(cls, selector);
  return method ? method_setImplementation(method, replacement) : NULL;
}

static void guardFocus(void) {
  originalActivateIgnoring = swap([NSApplication class], @selector(activateIgnoringOtherApps:), (IMP)guardedActivateIgnoring);
  if ([NSApplication instancesRespondToSelector:@selector(activate)]) originalActivate = swap([NSApplication class], @selector(activate), (IMP)guardedActivate);
  originalRunningActivate = swap([NSRunningApplication class], @selector(activateWithOptions:), (IMP)guardedRunningActivate);
  originalOrderFront = swap([NSWindow class], @selector(orderFront:), (IMP)guardedOrderFront);
  originalMakeKeyAndOrderFront = swap([NSWindow class], @selector(makeKeyAndOrderFront:), (IMP)guardedMakeKeyAndOrderFront);
  originalOrderFrontRegardless = swap([NSWindow class], @selector(orderFrontRegardless), (IMP)guardedOrderFrontRegardless);
  originalRequestAttention = swap([NSApplication class], @selector(requestUserAttention:), (IMP)guardedRequestAttention);
  originalSetString = swap([NSPasteboard class], @selector(setString:forType:), (IMP)watchedSetString);
  originalCursorSet = swap([NSCursor class], @selector(set), (IMP)watchedCursorSet);
  originalSetContents = swap([CALayer class], @selector(setContents:), (IMP)watchedSetContents);
}

// ─── Start ───────────────────────────────────────────────────────────────────

static void observe(void) {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  for (NSNotificationName name in @[ NSWindowDidBecomeKeyNotification, NSWindowDidResizeNotification, NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification, NSWindowDidChangeBackingPropertiesNotification, NSWindowDidChangeOcclusionStateNotification ]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      sendWindows();
    }];
  }
  [center addObserverForName:NSWindowWillCloseNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
    NSWindow *window = note.object;
    markLine(@{ @"e": @"window-closed", @"id": @(window.windowNumber) });
    dispatch_async(dispatch_get_main_queue(), ^{
      sendWindows();
    });
  }];
  [center addObserverForName:NSApplicationDidFinishLaunchingNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
    // Launched from a terminal, AppKit makes an app active: hand the Mac back to whoever had it.
    if (NSApp.isActive) [NSApp deactivate];
    atomic_store(&gStarted, true);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(300 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
      sendWindows();
    });
  }];
}

__attribute__((constructor)) static void capmacAppHook(void) {
  const char *config = getenv("CAPMAC_APP_HOOK");
  if (!config) return;
  NSArray<NSString *> *parts = [[NSString stringWithUTF8String:config] componentsSeparatedByString:@":"];
  // Child processes of the app never load the module.
  unsetenv("CAPMAC_APP_HOOK");
  unsetenv("DYLD_INSERT_LIBRARIES");
  if (parts.count < 2) return;
  gPort = parts[0].intValue;
  gToken = parts[1];
  gClients = [NSMutableArray array];
  gLock = [NSObject new];
  gCaptureQueue = dispatch_queue_create("dev.capmac.apphook.capture", DISPATCH_QUEUE_SERIAL);
  signal(SIGPIPE, SIG_IGN);
  guardFocus();
  observe();
  BOOL listening = listenOn(gPort);
  markLine(@{
    @"e": @"hello", @"pid": @(getpid()), @"name": NSProcessInfo.processInfo.processName ?: @"", @"electron": @"", @"chrome": @"", @"node": @"",
    @"socket": listening ? [NSString stringWithFormat:@"tcp:127.0.0.1:%d", gPort] : [NSNull null], @"dialogs": [NSNull null], @"h264": @YES, @"native": @YES,
  });
  if (!listening) markLine(@{ @"e": @"note", @"message": [NSString stringWithFormat:@"CapMac could not listen on port %d: the window will not show in CapMac.", gPort] });
}
