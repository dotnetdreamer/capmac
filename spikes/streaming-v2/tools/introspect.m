// Maps the simulator's private Objective-C API in the installed Xcode: classes,
// protocols, methods, and the extended type encodings that spell out block
// parameters (how the Xcode 26 SimScreen callbacks were found).
//
//   xcrun clang -fobjc-arc -framework Foundation introspect.m -o introspect
//   ./introspect                         classes and protocols that look display- or input-related
//   ./introspect SimDeviceIOClient       one class: methods, properties, protocols
//   ./introspect @SimScreen              one protocol, with block signatures
//   ./introspect --image SimulatorKit    every class in a loaded framework
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/runtime.h>

extern const char *_protocol_getMethodTypeEncoding(Protocol *p, SEL sel, BOOL isRequiredMethod, BOOL isInstanceMethod);

static void dumpClass(const char *name) {
  Class c = objc_getClass(name);
  if (!c) { printf("-- %s: not found\n", name); return; }
  printf("== %s (superclass %s, image %s)\n", name, class_getName(class_getSuperclass(c)), class_getImageName(c) ?: "?");
  unsigned n = 0;
  Method *methods = class_copyMethodList(c, &n);
  for (unsigned i = 0; i < n; i++) printf("  - %s  %s\n", sel_getName(method_getName(methods[i])), method_getTypeEncoding(methods[i]));
  free(methods);
  methods = class_copyMethodList(object_getClass(c), &n);
  for (unsigned i = 0; i < n; i++) printf("  + %s\n", sel_getName(method_getName(methods[i])));
  free(methods);
  objc_property_t *props = class_copyPropertyList(c, &n);
  for (unsigned i = 0; i < n; i++) printf("  @ %s  %s\n", property_getName(props[i]), property_getAttributes(props[i]));
  free(props);
  Protocol * __unsafe_unretained *protos = class_copyProtocolList(c, &n);
  for (unsigned i = 0; i < n; i++) printf("  <%s>\n", protocol_getName(protos[i]));
  free(protos);
}

static void dumpProtocol(const char *name) {
  Protocol *p = objc_getProtocol(name);
  if (!p) { printf("-- protocol %s: not found\n", name); return; }
  printf("== protocol %s\n", name);
  for (int required = 1; required >= 0; required--) {
    for (int instance = 1; instance >= 0; instance--) {
      unsigned n = 0;
      struct objc_method_description *d = protocol_copyMethodDescriptionList(p, required, instance, &n);
      for (unsigned i = 0; i < n; i++) {
        const char *ext = _protocol_getMethodTypeEncoding(p, d[i].name, required, instance);
        printf("  %s%s %s\n      %s\n", required ? "" : "(optional) ", instance ? "-" : "+", sel_getName(d[i].name), ext ?: d[i].types);
      }
      free(d);
    }
  }
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) printf("CoreSimulator: %s\n", dlerror());
    NSString *developer = NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"] ?: @"/Applications/Xcode.app/Contents/Developer";
    NSString *simulatorKit = [developer stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
    if (!dlopen(simulatorKit.UTF8String, RTLD_NOW)) printf("SimulatorKit: %s\n", dlerror());

    if (argc == 3 && !strcmp(argv[1], "--image")) {
      unsigned n = 0;
      const char **images = objc_copyImageNames(&n);
      for (unsigned i = 0; i < n; i++) {
        if (!strstr(images[i], argv[2])) continue;
        unsigned count = 0;
        const char **names = objc_copyClassNamesForImage(images[i], &count);
        printf("%u classes in %s\n", count, images[i]);
        for (unsigned k = 0; k < count; k++) printf("  %s\n", names[k]);
        free(names);
      }
      free(images);
      return 0;
    }
    if (argc == 1) {
      const char *needles[] = {"SimDisplay", "SimScreen", "SimDeviceIO", "IOSurface", "Framebuffer", "Renderable", "Indigo", "HID", "SimServiceContext", NULL};
      unsigned count = 0;
      Class *classes = objc_copyClassList(&count);
      for (unsigned i = 0; i < count; i++) {
        const char *n = class_getName(classes[i]);
        for (int k = 0; needles[k]; k++) if (strstr(n, needles[k])) { printf("class %s\n", n); break; }
      }
      free(classes);
      Protocol * __unsafe_unretained *protos = objc_copyProtocolList(&count);
      for (unsigned i = 0; i < count; i++) {
        const char *n = protocol_getName(protos[i]);
        for (int k = 0; needles[k]; k++) if (strstr(n, needles[k])) { printf("protocol %s\n", n); break; }
      }
      free(protos);
      return 0;
    }
    for (int i = 1; i < argc; i++) {
      if (argv[i][0] == '@') dumpProtocol(argv[i] + 1);
      else dumpClass(argv[i]);
    }
  }
  return 0;
}
