# Opens the same sites as tabs in browser-use (its BrowserSession, default
# settings, headless) and measures its browser's memory like bench/measure.ts.
# (Not named browser_use.py: that would shadow the browser_use package.)
import asyncio, datetime, json, os, re, subprocess, sys, time

SITES = re.findall(r'"(https://[^"]+)"', open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sites.ts")).read())


def tree(pid):
    pids = [pid]
    out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout
    for line in out.split():
        pids += tree(int(line))
    return pids


def browser_mb():
    chrome = browser_pids()
    if not chrome:
        return 0
    if sys.platform == "linux":
        return pss_mb(chrome)
    args = ["footprint", "-f", "bytes"]
    for p in chrome:
        args += ["-p", p]
    text = subprocess.run(args, capture_output=True, text=True).stdout
    totals = re.findall(r"Footprint:\s+(\d+) B", text)
    return round(int(totals[-1]) / 1024 / 1024) if totals else 0


def browser_pids():
    pids = tree(os.getpid())
    out = subprocess.run(["ps", "-o", "pid=,command=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout
    return [l.split()[0] for l in out.strip().split("\n") if re.search("chrom", l, re.I)]


def cpu_seconds(pids):
    """Linux: the CPU time each process has used so far, like bench/measure.ts."""
    ticks = os.sysconf("SC_CLK_TCK")
    used = {}
    for pid in pids:
        try:
            stat = open(f"/proc/{pid}/stat").read()
        except OSError:
            continue
        fields = stat[stat.rindex(")") + 2:].split(" ")
        used[pid] = (int(fields[11]) + int(fields[12])) / ticks
    return used


async def watch_idle(minutes, every=15):
    """Leaves the browser alone and samples memory and CPU every 15 s, like bench/measure.ts."""
    samples = []
    started = time.time()
    before = cpu_seconds(browser_pids())
    while time.time() - started < minutes * 60:
        await asyncio.sleep(every)
        after = cpu_seconds(browser_pids())
        used = sum(total - before.get(pid, 0) for pid, total in after.items())
        sample = {"seconds": round(time.time() - started), "mb": browser_mb(), "cpuPercent": round(used / every * 100)}
        samples.append(sample)
        print(f"idle {sample['seconds']:>4} s  {sample['mb']:>6} MB  {sample['cpuPercent']}% CPU", flush=True)
        before = after
    return samples


def flag(name, default):
    return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def pss_mb(pids):
    kilobytes = 0
    for pid in pids:
        try:
            rollup = open(f"/proc/{pid}/smaps_rollup").read()
        except OSError:
            continue
        found = re.search(r"^Pss:\s+(\d+) kB", rollup, re.M)
        if found:
            kilobytes += int(found.group(1))
    return round(kilobytes / 1024)


async def main():
    from browser_use import BrowserSession

    count = int(sys.argv[1]) if len(sys.argv) > 1 else len(SITES)
    idle_minutes = flag("--idle", 0)
    until_mb = flag("--until-mb", float("inf"))
    # More tabs than sites opens the sites again from the top, like bench/run.ts.
    sites = [SITES[i % len(SITES)] for i in range(count)]
    started = time.time()
    # The benchmark's machine runs as root, where Chrome only starts without its
    # sandbox (the others turn it off themselves). It doesn't change memory.
    session = BrowserSession(headless=True, chromium_sandbox=False)
    await session.start()
    idle_mb = browser_mb()
    per_tab = []
    worked = 0
    stopped = None
    for i, url in enumerate(sites):
        ok = False
        opened = time.time()
        try:
            await asyncio.wait_for(session.navigate_to(url, new_tab=i > 0), 45)
            page = await session.get_current_page()
            length = await asyncio.wait_for(page.evaluate("() => document.body.innerText.length"), 15)
            ok = int(length) > 200
        except Exception as error:
            pass
        worked += ok
        load_ms = round((time.time() - opened) * 1000)
        total_mb = browser_mb()
        per_tab.append({"url": url, "loadMs": load_ms, "totalMb": total_mb, "worked": ok})
        print(f"{len(per_tab):>3}  {total_mb:>6} MB  {'ok  ' if ok else 'FAIL'}  {url}", flush=True)
        if total_mb == 0 and i > 0:
            stopped = "crashed"
            break
        if total_mb >= until_mb:
            stopped = "memory limit"
            break
    seconds = round(time.time() - started)
    await asyncio.sleep(5)
    final_mb = browser_mb()
    print(f"\nbrowser-use: {final_mb} MB with {len(per_tab)} tabs ({worked} worked), {seconds} s", flush=True)
    idle = None
    if idle_minutes > 0 and stopped != "crashed":
        idle = await watch_idle(idle_minutes)
    await session.kill()

    measured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    summary = {"browser": "browser-use", "tabs": len(per_tab), "worked": worked, "idleMb": idle_mb, "finalMb": final_mb,
               "loadSeconds": seconds, "stopped": stopped, "idle": idle, "measuredAt": measured_at, "perTab": per_tab}
    results = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results")
    os.makedirs(results, exist_ok=True)
    suffix = f"-idle{int(idle_minutes)}m" if idle_minutes > 0 else ""
    name = f"browser-use{suffix}-{len(per_tab)}-{re.sub(r'[:.+]', '-', measured_at)}.json"
    with open(os.path.join(results, name), "w") as out:
        json.dump(summary, out, indent=2)
    print(f"saved {name}", flush=True)


asyncio.run(main())
