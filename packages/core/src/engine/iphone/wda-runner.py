# Starts WebDriverAgent's test runner on an iPhone and forwards local ports to it: its HTTP port
# (taps and the rest) and its screen stream (MJPEG).
#
# argv: UDID, iOS version, runner bundle id, device port (8100), usb | wifi, screen port (9100).
# Over the cable, the ports are reached through usbmux (CapMac mounts the developer services first).
# Over Wi-Fi, the developer services, the test daemon and the ports are reached through one no-admin
# tunnel (RemotePairing, as Xcode does): CapMac puts device.ts's OVER_WIFI (over_wifi) in front of
# this script.
# WebDriverAgent listens only where CapMac reaches it (USE_IP): on the iPhone itself for the cable, on
# the tunnel's address for Wi-Fi. Left alone it takes taps from, and streams its screen to, anyone on
# the same Wi-Fi.
# Prints CAPMAC_PORT <port> <screen port> once WebDriverAgent answers, CAPMAC_LOCKED while a Wi-Fi
# iPhone is away (locked or asleep), and CAPMAC_ENDED <reason> when the runner stops. Runs until stdin
# closes (CapMac stops it), then stops the runner. Run with CapMac's own Python (pymobiledevice3 11.32).
import asyncio
import ipaddress
import sys

from pymobiledevice3 import usbmux
from pymobiledevice3.exceptions import AlreadyMountedError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote import userspace_tunnel
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestListener, XCUITestService
from pymobiledevice3.services.mobile_image_mounter import auto_mount


def say(*words):
    print(*words, flush=True)


class Takeover(XCUITestListener):
    """XCTest couldn't take over the screen: it says so once and then waits for nothing. With a
    passcode set, the iPhone asks for it first ("Timed out while enabling automation mode")."""

    def __init__(self):
        self.failed = asyncio.get_running_loop().create_future()

    async def initialization_for_ui_testing_did_fail(self, error):
        self.fail(error)

    async def did_fail_to_bootstrap(self, error):
        self.fail(error)

    def fail(self, error):
        if not self.failed.done():
            self.failed.set_result((error.user_info or {}).get('NSLocalizedDescription') or f'{error.domain} {error.code}')


def at_least(version, wanted):
    have = [int(part) for part in version.split('.')[:3] if part.isdigit()]
    have += [0] * (3 - len(have))
    return have >= list(wanted)


async def provider_for(udid, version, wifi):
    # Over Wi-Fi, and over the cable from iOS 17.4, the test daemon is behind the no-admin tunnel;
    # older iPhones reach it through lockdown on the cable.
    if wifi or at_least(version, (17, 4, 0)):
        if wifi:
            userspace_tunnel._create_no_root_tunnel_provider = over_wifi
        tunnel = userspace_tunnel.UserspaceRsdTunnel(serial=udid)
        # over_wifi waits up to five minutes for an asleep iPhone.
        rsd = await asyncio.wait_for(tunnel.aopen(), 360 if wifi else 120)
        return rsd, tunnel
    if at_least(version, (17, 0, 0)):
        raise SystemExit('iOS 17.0 to 17.3 needs an administrator tunnel: update the iPhone to iOS 17.4 or later')
    return await create_using_usbmux(serial=udid, autopair=False), None


def tunnel_address(rsd):
    # The iPhone's end of the tunnel, written as the iPhone writes it: WebDriverAgent finds the
    # interface to listen on by comparing that text.
    return str(ipaddress.ip_address(rsd.service.address[0]))


def connector(udid, port, rsd, wifi):
    """Opens a connection to WebDriverAgent's port: through the Wi-Fi tunnel, or usbmux on the cable."""
    if wifi:
        address = tunnel_address(rsd)
        return lambda: rsd.open_connection(address, port)

    async def over_usb():
        device = await usbmux.select_device(udid)
        if device is None:
            raise ConnectionError('the iPhone is not plugged in')
        sock = await device.connect(port)
        sock.setblocking(False)
        return await asyncio.open_connection(sock=sock)

    return over_usb


async def answers(connect):
    # Through the tunnel a connection opens even while nothing listens on the iPhone: ask for real.
    try:
        reader, writer = await asyncio.wait_for(connect(), 5)
    except Exception:
        return False
    try:
        writer.write(b'GET /status HTTP/1.1\r\nHost: wda\r\nConnection: close\r\n\r\n')
        await writer.drain()
        return (await asyncio.wait_for(reader.read(12), 5)).startswith(b'HTTP/1.')
    except Exception:
        return False
    finally:
        writer.close()


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def forward(connect, local_reader, local_writer):
    try:
        remote_reader, remote_writer = await connect()
    except Exception:
        local_writer.close()
        return
    await asyncio.gather(pipe(local_reader, remote_writer), pipe(remote_reader, local_writer))


async def stdin_closed():
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, sys.stdin.buffer.read)


async def main(udid, version, runner, port, transport, screen_port='9100'):
    port = int(port)
    wifi = transport == 'wifi'
    provider, tunnel = await provider_for(udid, version, wifi)
    try:
        if wifi:
            try:
                await auto_mount(provider)
            except AlreadyMountedError:
                pass
        config = await TestConfig.create_for(provider, runner_bundle_id=runner)
        # usbmux connections arrive on the iPhone's IPv4 loopback ("localhost" left it unreachable).
        config.runner_app_env = {'USE_IP': tunnel_address(provider) if wifi else '127.0.0.1'}
        takeover = Takeover()
        runner_task = asyncio.create_task(XCUITestService(provider).run(config, listener=takeover), name='wda-runner')
        connect = connector(udid, port, provider, wifi)
        deadline = asyncio.get_running_loop().time() + 90
        while not await answers(connect):
            if runner_task.done():
                runner_task.result()
                raise SystemExit('WebDriverAgent stopped before it answered')
            if takeover.failed.done():
                raise SystemExit(f'XCTest could not take over the screen: {takeover.failed.result()}')
            if asyncio.get_running_loop().time() > deadline:
                raise SystemExit('WebDriverAgent did not answer within a minute and a half')
            await asyncio.sleep(0.2)
        server = await asyncio.start_server(lambda r, w: forward(connect, r, w), '127.0.0.1', 0)
        screen_connect = connector(udid, int(screen_port), provider, wifi)
        screen = await asyncio.start_server(lambda r, w: forward(screen_connect, r, w), '127.0.0.1', 0)
        say('CAPMAC_PORT', server.sockets[0].getsockname()[1], screen.sockets[0].getsockname()[1])
        closed = asyncio.create_task(stdin_closed())
        done, _ = await asyncio.wait({runner_task, closed}, return_when=asyncio.FIRST_COMPLETED)
        server.close()
        screen.close()
        if runner_task in done:
            error = runner_task.exception()
            say('CAPMAC_ENDED', str(error) if error else 'the test runner finished')
        else:
            runner_task.cancel()
            try:
                await runner_task
            except BaseException:
                pass
    finally:
        if tunnel is not None:
            await tunnel.aclose()


asyncio.run(main(*sys.argv[1:]))
