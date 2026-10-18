# Streams an iPhone's screen to CapMac the way Xcode 26's Device Hub does (CoreDevice's display
# service, iOS 26 and later), and takes touch, buttons and keys for it (dtuhidd's HID services: they
# act only while such a stream runs). Reached through the no-admin tunnel: CoreDeviceProxy on the
# cable, RemotePairing over Wi-Fi (CapMac puts device.ts's OVER_WIFI, over_wifi, in front of this
# script for that).
#
# argv: UDID, usb | wifi, the local UDP port CapMac takes the stream's RTP on, codec (h264 | hevc |
# any). The video goes to that port as it comes (RTP: payload type 100 is H.264, 123 HEVC); CapMac
# puts the pictures together.
# stdin, one JSON object a line:
#   {"t": "key"}                                    a keyframe, now
#   {"t": "touch", "down": bool, "x": 0..1, "y": 0..1} the finger, down at or moving to (x, y), or lifted
#   {"t": "button", "name": "home", "down": bool}   home, lock, volume-up, volume-down
#   {"t": "keys", "usages": [int, ...]}             the keyboard keys held now (HID usages)
#   {"t": "shot"}                                   a PNG of the screen, printed as CAPMAC_SHOT <base64>
# Prints CAPMAC_STREAM once the stream runs, CAPMAC_LOCKED while a Wi-Fi iPhone is away,
# and CAPMAC_ENDED <reason> when it stops. Runs until stdin closes, then ends the stream on the iPhone
# (which also frees its camera and microphone: iOS keeps them from apps while its screen is watched).
# Run with CapMac's own Python (pymobiledevice3 11.32).
import asyncio
import base64
import contextlib
import json
import plistlib
import socket
import struct
import sys
import threading
import time
import zlib

from pymobiledevice3.exceptions import AlreadyMountedError
from pymobiledevice3.remote import userspace_tunnel
from pymobiledevice3.remote.core_device import display_service, media_stream_offer as offer
from pymobiledevice3.remote.core_device.display_service import DisplayService
from pymobiledevice3.remote.core_device.hid_service import (
    HID_BUTTON_STATE_DOWN, HID_BUTTON_STATE_UP, KEYBOARD_ATTACH_SETTLE_SECONDS, TOUCHSCREEN_STATE_CONTACT,
    TOUCHSCREEN_STATE_RELEASE, IndigoHIDService, UniversalHIDServiceService,
)
from pymobiledevice3.remote.core_device.screen_capture_service import ScreenCaptureService
from pymobiledevice3.remote.core_device.screen_stream import open_media_receiver
from pymobiledevice3.services.mobile_image_mounter import auto_mount
from pymobiledevice3.services.power_assertion import PowerAssertionService

# The buttons as HID usages (page, code) and how long a press holds them: iOS takes a lock press
# that is too short for a bounce.
BUTTONS = {'home': (0x0C, 0x40, 0.05), 'lock': (0x0C, 0x30, 0.5), 'volume-up': (0x0C, 0xE9, 0.05), 'volume-down': (0x0C, 0xEA, 0.05)}
# The iPhone stops a stream that hears nothing back for about 25 s: a receiver report every second.
REPORT_EVERY = 1.0
# The picture stops for good when the encoder chokes: started again after this long without one.
STALLED_AFTER = 5.0
# Keeps the iPhone from locking by itself while its screen is shown (renewed well before it ends).
AWAKE_FOR = 300
AWAKE_RENEW = 120


def say(*words):
    print(*words, flush=True)


def offer_for(codec):
    """The video offer with only one codec bank: the iPhone answers with that codec."""
    def build(call_id, session_id, host_model='Mac15,9', host_os_version='2205.3.1', host_build='25F80', *,
              allow_rtcp_fb=False, ltrp_enabled=False, fec_enabled=True, tiles_per_frame=1,
              hevc_features=offer._DEFAULT_HEVC_FEATURES, avc_features=offer._DEFAULT_AVC_FEATURES):
        bank = (offer._codec_bank(123, hevc_features, 1, res_pair_count=4) if codec == 'hevc'
                else offer._codec_bank(100, avc_features, 14, res_pair_count=2))
        settings = (offer._tag(1, 0) + offer._varint_padded(session_id, 5) + offer._f_varint(2, 1 if allow_rtcp_fb else 0)
                    + offer._f_bytes(3, bank) + offer._f_varint(7, 1 if ltrp_enabled else 0) + offer._f_varint(8, 63)
                    + (offer._f_varint(10, 1) if fec_enabled else b'') + offer._f_varint(12, 1))
        blob = offer._build_top_level(settings_field=5, settings_body=settings, decoder_name=offer.DEFAULT_DECODER_NAME,
                                      timestamp=offer._CAPTURED_VIDEO_TIMESTAMP, bitrate_tiers=offer._DEFAULT_VIDEO_BITRATE_TIERS)
        return plistlib.dumps({
            'avcMediaStreamOptionRemoteEndpointInfo': offer.build_remote_endpoint_info(host_model, host_os_version, host_build),
            'avcMediaStreamNegotiatorMode': offer.NEGOTIATOR_MODE_VIDEO,
            # The iPhone refuses any other compression of it.
            'avcMediaStreamNegotiatorMediaBlob': zlib.compress(blob, level=9),
            'avcMediaStreamOptionCallID': call_id,
        }, fmt=plistlib.FMT_BINARY)
    return build


class Stream:
    """One video stream from the iPhone, relayed to CapMac's port, with what keeps it going."""

    def __init__(self, rsd, port):
        self.rsd = rsd
        self.port = port
        self.service = None
        self.receiver = None
        self.relay = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.relay.setblocking(False)
        self.dest = None
        self.ssrcs = (0, 0)
        self.highest = 0
        self.last_packet = time.monotonic()
        self.tasks = []

    async def start(self):
        self.service = DisplayService(self.rsd)
        await self.service.connect()
        self.receiver, address = open_media_receiver(self.service, (8 << 20, 4 << 20))
        answer = await asyncio.wait_for(self.service.start_video_stream(
            receiver_ip=address, receiver_port=self.receiver.port, sender_ip=self.rsd.service.address[0]), 20)
        config = answer['connection'].get('streamConfig', {})
        # The answer names the ends from the iPhone's side: its LocalSSRC is the stream's, RemoteSSRC ours.
        self.ssrcs = (int(config.get('RemoteSSRC', 0)), int(config.get('LocalSSRC', 0)))
        source_port = int(config.get('SourcePort', 0))
        self.dest = (self.rsd.service.address[0], source_port) if source_port else None
        self.last_packet = time.monotonic()
        self.tasks = [asyncio.create_task(self.forward()), asyncio.create_task(self.report())]

    async def forward(self):
        while True:
            data = await self.receiver.recv(65535)
            if len(data) < 12 or 64 <= (data[1] & 0x7F) <= 95:
                continue
            self.highest = int.from_bytes(data[2:4], 'big')
            self.last_packet = time.monotonic()
            with contextlib.suppress(BlockingIOError, OSError):
                self.relay.sendto(data, ('127.0.0.1', self.port))

    async def report(self):
        mine, theirs = self.ssrcs
        sdes = struct.pack('!BBHI BBBB', 0x81, 0xCA, 2, mine, 1, 0, 0, 0)
        while True:
            await asyncio.sleep(REPORT_EVERY)
            if self.dest and mine and theirs:
                rr = struct.pack('!BBHII BBBB IIII', 0x81, 0xC9, 7, mine, theirs, 0, 0, 0, 0, self.highest & 0xFFFFFFFF, 0, 0, 0)
                with contextlib.suppress(OSError):
                    await self.receiver.sendto(rr + sdes, *self.dest)

    async def keyframe(self):
        """A picture loss indication: the iPhone sends a keyframe."""
        mine, theirs = self.ssrcs
        if self.dest and mine and theirs:
            with contextlib.suppress(OSError):
                await self.receiver.sendto(struct.pack('!BBHII', 0x81, 0xCE, 2, mine, theirs), *self.dest)

    async def stop(self):
        for task in self.tasks:
            task.cancel()
        self.tasks = []
        if self.receiver is not None:
            self.receiver.close()
        if self.service is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.service.close(), 2)


class Input:
    """Touch, buttons and keys, through the HID services (they act while a stream runs)."""

    def __init__(self, rsd):
        self.rsd = rsd
        self.hid = None
        self.indigo = None
        self.keyboard = None
        self.finger = None

    async def reset(self):
        for service in (self.hid, self.indigo):
            if service is not None:
                with contextlib.suppress(Exception):
                    await service.close()
        self.hid = self.indigo = self.keyboard = None
        self.finger = None

    async def ready(self):
        if self.hid is None:
            self.hid = UniversalHIDServiceService(self.rsd)
            await self.hid.connect()
        if self.indigo is None:
            self.indigo = IndigoHIDService(self.rsd)
            await self.indigo.connect()

    async def touch(self, down, x, y):
        await self.ready()
        point = (round(min(1, max(0, x)) * 65535), round(min(1, max(0, y)) * 65535))
        if down:
            self.finger = point
            await self.hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, *point)
        elif self.finger is not None:
            self.finger = None
            await self.hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, *point)

    async def button(self, name, down):
        await self.ready()
        page, code, hold = BUTTONS[name]
        if down is None:
            await self.indigo.send_button(page, code, HID_BUTTON_STATE_DOWN)
            await asyncio.sleep(hold)
            await self.indigo.send_button(page, code, HID_BUTTON_STATE_UP)
        else:
            await self.indigo.send_button(page, code, HID_BUTTON_STATE_DOWN if down else HID_BUTTON_STATE_UP)

    async def keys(self, usages):
        await self.ready()
        if self.keyboard is None:
            self.keyboard = await self.hid.create_keyboard_service()
            # A key pressed while the new keyboard attaches sticks.
            await asyncio.sleep(KEYBOARD_ATTACH_SETTLE_SECONDS)
        await self.hid.send_keyboard(self.keyboard, [int(u) for u in usages])


async def keep_awake(rsd):
    while True:
        with contextlib.suppress(Exception):
            async with PowerAssertionService(rsd).create_power_assertion(
                    'PreventUserIdleSystemSleep', 'CapMac', AWAKE_FOR, 'CapMac shows this screen'):
                pass
        await asyncio.sleep(AWAKE_RENEW)


async def commands():
    """stdin's commands, as they come, until it closes."""
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue()

    def read():
        for line in sys.stdin:
            loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    # Its own thread, which doesn't keep the helper from exiting once the stream ended.
    threading.Thread(target=read, daemon=True).start()
    while True:
        line = await queue.get()
        if line is None:
            return
        with contextlib.suppress(ValueError):
            yield json.loads(line)


async def main(udid, transport, port, codec='h264'):
    wifi = transport == 'wifi'
    if wifi:
        userspace_tunnel._create_no_root_tunnel_provider = over_wifi
    # 'any': Xcode's offer, both codecs (the iPhone picks).
    if codec in ('h264', 'hevc'):
        display_service.build_negotiator_offer_video = offer_for(codec)
    tunnel = userspace_tunnel.UserspaceRsdTunnel(serial=udid)
    # over_wifi waits up to five minutes for an asleep iPhone.
    rsd = await asyncio.wait_for(tunnel.aopen(), 360 if wifi else 120)
    stream = Stream(rsd, int(port))
    touch = Input(rsd)
    awake = None
    try:
        try:
            await auto_mount(rsd)
        except AlreadyMountedError:
            pass
        await stream.start()
        # The HID services see the stream a moment later.
        await asyncio.sleep(0.3)
        awake = asyncio.create_task(keep_awake(rsd))
        say('CAPMAC_STREAM')
        restarts = 0

        async def watch():
            nonlocal restarts
            while True:
                await asyncio.sleep(1)
                if time.monotonic() - stream.last_packet < STALLED_AFTER:
                    restarts = 0
                    continue
                if restarts >= 3:
                    raise RuntimeError('the iPhone stopped sending its screen')
                restarts += 1
                await stream.stop()
                await touch.reset()
                await stream.start()
                await asyncio.sleep(0.3)

        watcher = asyncio.create_task(watch())

        async def run_commands():
            async for command in commands():
                kind = command.get('t')
                try:
                    if kind == 'key':
                        await stream.keyframe()
                    elif kind == 'touch':
                        await touch.touch(bool(command.get('down')), float(command.get('x', 0)), float(command.get('y', 0)))
                    elif kind == 'button' and command.get('name') in BUTTONS:
                        await touch.button(command['name'], command.get('down'))
                    elif kind == 'keys':
                        await touch.keys(command.get('usages') or [])
                    elif kind == 'shot':
                        async with ScreenCaptureService(rsd) as capture:
                            shot = await capture.capture_screenshot()
                        say('CAPMAC_SHOT', base64.b64encode(shot['image']).decode('ascii'))
                except (ConnectionError, OSError, asyncio.IncompleteReadError):
                    raise
                except Exception as error:
                    print(f'{kind}: {error}', file=sys.stderr, flush=True)
                    if kind == 'shot':
                        say('CAPMAC_SHOT')

        reader = asyncio.create_task(run_commands())
        done, _ = await asyncio.wait({watcher, reader}, return_when=asyncio.FIRST_COMPLETED)
        if watcher in done:
            say('CAPMAC_ENDED', str(watcher.exception() or 'the stream stopped'))
        elif reader.exception() is not None:
            say('CAPMAC_ENDED', str(reader.exception()))
        for task in (watcher, reader):
            task.cancel()
    finally:
        if awake is not None:
            awake.cancel()
        with contextlib.suppress(Exception):
            await touch.reset()
        await stream.stop()
        # Ends the session on the iPhone: its screen is no longer watched, its camera and microphone are free.
        with contextlib.suppress(Exception):
            await asyncio.wait_for(DisplayService.stop_all_streams(rsd), 6)
        with contextlib.suppress(Exception):
            await tunnel.aclose()


if __name__ == '__main__':
    if 'over_wifi' not in globals():
        async def over_wifi(serial, autopair, fallback):
            raise SystemExit('Wi-Fi needs CapMac to run this')
    asyncio.run(main(*sys.argv[1:]))
