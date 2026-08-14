import urllib.request
import urllib.error
import json
import ssl
import sys

TARGET = "https://maheshfoundation-medical.com"

CHECKS = [
    {"name": "Frontend Web Application", "path": "/", "expected_code": 200, "check_json": False},
    {"name": "Public Centers List API", "path": "/api/v1/centers", "expected_code": 200, "check_json": True},
    {"name": "Public Medical Equipment SKUs API", "path": "/api/v1/skus", "expected_code": 200, "check_json": True},
    {"name": "OpenAPI Documentation Endpoint", "path": "/docs", "expected_code": 200, "check_json": False},
]

def run_check(base_url, check):
    url = f"{base_url}{check['path']}"
    print(f" Checking {check['name']:<35} [{check['path']}]... ", end="")
    
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SystemVerifier/1.0"})
        with urllib.request.urlopen(req, timeout=5, context=ctx) as resp:
            code = resp.status
            body = resp.read().decode('utf-8')
            
            if code == check['expected_code']:
                if check['check_json']:
                    try:
                        data = json.loads(body)
                        item_count = len(data) if isinstance(data, list) else "OK"
                        print(f"PASSED (HTTP {code} | Data Count: {item_count})")
                        return True
                    except Exception as e:
                        print(f"FAILED (Invalid JSON: {e})")
                        return False
                else:
                    print(f"PASSED (HTTP {code})")
                    return True
            else:
                print(f"FAILED (Expected {check['expected_code']}, got {code})")
                return False
    except urllib.error.HTTPError as e:
        print(f"FAILED (HTTP {e.code})")
        return False
    except Exception as e:
        print(f"FAILED ({e})")
        return False

def main():
    print("=======================================================")
    print(" SYSTEM HEALTH & API INTEGRITY VERIFICATION REPORT")
    print("=======================================================")
    print(f"Targeting Live URL: {TARGET}\n")
    
    passed_count = 0
    total_checks = len(CHECKS)
    
    for check in CHECKS:
        if run_check(TARGET, check):
            passed_count += 1
            
    print("\n-------------------------------------------------------")
    if passed_count == total_checks:
        print(f" ALL CHECKS PASSED ({passed_count}/{total_checks}) - SYSTEM FULLY OPERATIONAL!")
    else:
        print(f" WARNING: {total_checks - passed_count} check(s) failed out of {total_checks}.")
    print("=======================================================\n")

if __name__ == "__main__":
    main()
