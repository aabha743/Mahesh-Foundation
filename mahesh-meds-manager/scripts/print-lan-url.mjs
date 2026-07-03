import os from "node:os";

const port = Number(process.env.PORT ?? 8080);

function lanAddresses() {
  const seen = new Set();
  const addrs = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue;
    for (const details of iface) {
      if (details.family !== "IPv4" || details.internal) continue;
      if (seen.has(details.address)) continue;
      seen.add(details.address);
      addrs.push(details.address);
    }
  }
  return addrs;
}

const ips = lanAddresses();
console.log("\nMahesh Meds Manager — open on your phone (same Wi‑Fi):\n");
if (ips.length === 0) {
  console.log("  Could not detect a LAN IPv4 address. Check Wi‑Fi, then use ipconfig.\n");
} else {
  for (const ip of ips) {
    console.log(`  http://${ip}:${port}`);
  }
  console.log("\n  Backend is proxied through Vite — only port 8080 must be reachable.\n");
}
