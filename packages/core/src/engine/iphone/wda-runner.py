# Starts WebDriverAgent's test runner on a plugged-in iPhone and forwards a local port to it.
#
# argv: UDID, iOS version, runner bundle id, device port (8100).
# Prints CAPMAC_PORT <port> once WebDriverAgent answers on the iPhone, and CAPMAC_ENDED <reason>
# when the runner stops. Runs until stdin closes (CapMac stops it), then stops the runner.
# Run with CapMac's own Python (pymobiledevice3 11.32).
import asyncio
import sys

from pymobiledevice3 import usbmux
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestService


def say(*words):
    print(*words, flush=True)


def at_least(version, wanted):
    have = [int(part) for part in version.split('.')[:3] if part.isdigit()]
    have += [0] * (3 - len(have))
    return have >= list(wanted)


async def provider_for(udid, version):
    # iOS 17 and later reach the test daemon through the no-admin tunnel, older ones through lockdown.
    if at_least(version, (17, 4, 0)):
        from pymobiledevice3.remote import userspace_tunnel
        tunnel = userspace_tunnel.UserspaceRsdTunnel(serial=udid)
        rsd = await asyncio.wait_for(tunnel.aopen(), 120)
        return rsd, tunnel
    if at_least(version, (17, 0, 0)):
        raise SystemExit('iOS 17.0 to 17.3 needs an administrator tunnel: update the iPhone to iOS 17.4 or later')
    return await create_using_usbmux(serial=udid, autopair=False), None


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


async def forward(udid, port, local_reader, local_writer):
    try:
        device = await usbmux.select_device(udid)
        if device is None:
            local_writer.close()
            return
        sock = await device.connect(port)
        sock.setblocking(False)
        remote_reader, remote_writer = await asyncio.open_connection(sock=sock)
    except Exception:
        local_writer.close()
        return
    await asyncio.gather(pipe(local_reader, remote_writer), pipe(remote_reader, local_writer))


async def reachable(udid, port):
    device = await usbmux.select_device(udid)
    if device is None:
        return False
    try:
        sock = await device.connect(port)
    except Exception:
        return False
    sock.close()
    return True


async def stdin_closed():
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, sys.stdin.buffer.read)


async def main(udid, version, runner, port):
    port = int(port)
    provider, tunnel = await provider_for(udid, version)
    try:
        config = await TestConfig.create_for(provider, runner_bundle_id=runner)
        runner_task = asyncio.create_task(XCUITestService(provider).run(config), name='wda-runner')
        deadline = asyncio.get_running_loop().time() + 60
        while not await reachable(udid, port):
            if runner_task.done():
                runner_task.result()
                raise SystemExit('WebDriverAgent stopped before it answered')
            if asyncio.get_running_loop().time() > deadline:
                raise SystemExit('WebDriverAgent did not answer within a minute')
            await asyncio.sleep(0.2)
        server = await asyncio.start_server(lambda r, w: forward(udid, port, r, w), '127.0.0.1', 0)
        say('CAPMAC_PORT', server.sockets[0].getsockname()[1])
        closed = asyncio.create_task(stdin_closed())
        done, _ = await asyncio.wait({runner_task, closed}, return_when=asyncio.FIRST_COMPLETED)
        server.close()
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
