import concurrent.futures
import json
import time
import urllib.error
import urllib.request
import statistics
import sys

TARGET_HOSTS = [
    "https://maheshfoundation-medical.com",
    "http://35.222.32.191"
]

ENDPOINTS = [
    ("/", "Frontend Index Page"),
    ("/health", "API Health Check"),
    ("/api/v1/centers", "Public Centers API"),
    ("/api/v1/skus", "Public SKUs Catalog API")
]

STAGES = [
    {"name": "Stage 1: Sanity Baseline", "concurrency": 5, "duration_sec": 15},
    {"name": "Stage 2: Moderate Load", "concurrency": 25, "duration_sec": 20},
    {"name": "Stage 3: High Capacity", "concurrency": 50, "duration_sec": 25},
    {"name": "Stage 4: Peak Stress Test", "concurrency": 100, "duration_sec": 30},
]

def check_target(base_url):
    url = f"{base_url}/health"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "MaheshLoadTester/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                return True
    except Exception as e:
        print(f"Target check failed for {base_url}: {e}")
        return False
    return False

def make_request(base_url, path):
    url = f"{base_url}{path}"
    start = time.perf_counter()
    status_code = 0
    error_msg = None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "MaheshLoadTester/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            status_code = resp.status
    except urllib.error.HTTPError as e:
        status_code = e.code
    except Exception as e:
        error_msg = str(e)
    latency_ms = (time.perf_counter() - start) * 1000.0
    return {
        "url": url,
        "path": path,
        "status": status_code,
        "latency_ms": latency_ms,
        "error": error_msg,
        "success": (status_code == 200)
    }

def run_worker(base_url, stop_time, results_list):
    idx = 0
    while time.time() < stop_time:
        path, desc = ENDPOINTS[idx % len(ENDPOINTS)]
        idx += 1
        res = make_request(base_url, path)
        results_list.append(res)
        time.sleep(0.05)  # 50ms pause per worker iteration to simulate realistic browser activity

def run_stage(base_url, stage):
    print(f"\n=======================================================")
    print(f" Running {stage['name']}")
    print(f" Concurrency: {stage['concurrency']} workers | Duration: {stage['duration_sec']}s")
    print(f"=======================================================")
    
    stop_time = time.time() + stage['duration_sec']
    results = []
    
    start_stage_time = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=stage['concurrency']) as executor:
        futures = [
            executor.submit(run_worker, base_url, stop_time, results)
            for _ in range(stage['concurrency'])
        ]
        concurrent.futures.wait(futures)
    
    total_duration = time.time() - start_stage_time
    total_reqs = len(results)
    successful_reqs = sum(1 for r in results if r['success'])
    failed_reqs = total_reqs - successful_reqs
    rps = total_reqs / total_duration if total_duration > 0 else 0
    
    latencies = [r['latency_ms'] for r in results]
    avg_lat = statistics.mean(latencies) if latencies else 0
    p50_lat = statistics.median(latencies) if latencies else 0
    p95_lat = sorted(latencies)[int(len(latencies) * 0.95)] if len(latencies) >= 20 else (max(latencies) if latencies else 0)
    max_lat = max(latencies) if latencies else 0
    
    print(f" Completed in {total_duration:.2f}s")
    print(f" Total Requests: {total_reqs} | Success: {successful_reqs} | Failed: {failed_reqs}")
    print(f" Throughput (RPS): {rps:.2f} req/sec")
    print(f" Latency (ms) - Avg: {avg_lat:.1f}ms | P50: {p50_lat:.1f}ms | P95: {p95_lat:.1f}ms | Max: {max_lat:.1f}ms")
    print(f" Success Rate: {(successful_reqs / total_reqs * 100):.2f}%" if total_reqs > 0 else " N/A")
    
    # Endpoint breakdown
    print("\n --- Endpoint Breakdown ---")
    for path, desc in ENDPOINTS:
        ep_res = [r for r in results if r['path'] == path]
        if ep_res:
            ep_succ = sum(1 for r in ep_res if r['success'])
            ep_lats = [r['latency_ms'] for r in ep_res]
            ep_avg = statistics.mean(ep_lats)
            ep_p95 = sorted(ep_lats)[int(len(ep_lats) * 0.95)] if len(ep_lats) >= 20 else max(ep_lats)
            print(f"  {path:<20} -> Count: {len(ep_res):<4} | Success: {ep_succ:<4} | Avg: {ep_avg:.1f}ms | P95: {ep_p95:.1f}ms")

def main():
    target = None
    print("Checking live target connectivity...")
    for host in TARGET_HOSTS:
        print(f"Testing connectivity to {host}...")
        if check_target(host):
            target = host
            print(f"SUCCESS: Connected to live host -> {target}")
            break
            
    if not target:
        # Try raw http on host 1 if https certificate fails locally
        target = "http://35.222.32.191"
        print(f"Fallback target set to -> {target}")
        
    print(f"\nStarting Stress & Workload Capability Analysis against {target}...")
    for stage in STAGES:
        run_stage(target, stage)
        time.sleep(3) # Short cooldown between stages

if __name__ == "__main__":
    main()
