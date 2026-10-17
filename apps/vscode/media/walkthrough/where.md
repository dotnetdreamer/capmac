# Where your app builds

**With a Mac.** Pair it once. CapMac reaches it over your network (or from anywhere, with remote access) and uses its Xcode, its iPhone and iPad simulators, the iPhones plugged into it, and its desktop for Mac apps. You never need to sit at the Mac.

- Turn on **Remote Login** on the Mac: System Settings › General › Sharing
- Run **CapMac: Pair a Mac** and pick it from the list

**No Mac.** This PC builds and signs your iPhone app itself, then installs it on an iPhone plugged in with a cable (and over Wi-Fi after that). One setup does it all: the build tools, one Apple sign-in, signing and the iPhone SDK.

- Run **CapMac: Set Up This PC for iPhones**

Both choices are remembered per project, and the `capmac` command and CapMac Studio use them too.
