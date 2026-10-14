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
    pids = tree(os.getpid())
    out = subprocess.run(["ps", "-o", "pid=,command=", "-p", ",".join(map(str, pids))], capture_output=True, text=True).stdout
    chrome = [l.split()[0] for l in out.strip().split("\n") if re.search("chrom", l, re.I)]
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
    started = time.time()
    # The benchmark's machine runs as root, where Chrome only starts without its
    # sandbox (the others turn it off themselves). It doesn't change memory.
    session = BrowserSession(headless=True, chromium_sandbox=False)
    await session.start()
    idle_mb = browser_mb()
    per_tab = []
    worked = 0
    for i, url in enumerate(SITES[:count]):
        ok = False
        try:
            await asyncio.wait_for(session.navigate_to(url, new_tab=i > 0), 45)
            page = await session.get_current_page()
            length = await asyncio.wait_for(page.evaluate("() => document.body.innerText.length"), 15)
            ok = int(length) > 200
        except Exception as error:
            pass
        worked += ok
        total_mb = browser_mb()
        per_tab.append({"url": url, "totalMb": total_mb, "worked": ok})
        print(f"{total_mb:>6} MB  {'ok  ' if ok else 'FAIL'}  {url}", flush=True)
    seconds = round(time.time() - started)
    await asyncio.sleep(5)
    final_mb = browser_mb()
    print(f"\nbrowser-use: {final_mb} MB with {count} tabs ({worked} worked), {seconds} s", flush=True)
    await session.kill()

    measured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    summary = {"browser": "browser-use", "tabs": count, "worked": worked, "idleMb": idle_mb, "finalMb": final_mb,
               "loadSeconds": seconds, "measuredAt": measured_at, "perTab": per_tab}
    results = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results")
    os.makedirs(results, exist_ok=True)
    name = f"browser-use-{count}-{re.sub(r'[:.+]', '-', measured_at)}.json"
    with open(os.path.join(results, name), "w") as out:
        json.dump(summary, out, indent=2)
    print(f"saved {name}", flush=True)


asyncio.run(main())
