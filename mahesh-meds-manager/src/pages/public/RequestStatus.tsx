import React from "react";
import { useParams } from "react-router-dom";

export default function RequestStatus() {
  const { token } = useParams();
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Track Request Status</h1>
      {token && <p className="text-sm font-mono text-muted-foreground mb-2">Tracking Code: {token}</p>}
      <p className="text-muted-foreground">Enter your tracking token or view your current request status.</p>
    </div>
  );
}
