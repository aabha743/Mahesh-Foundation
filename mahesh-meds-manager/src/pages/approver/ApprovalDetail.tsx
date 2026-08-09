import React from "react";
import { useParams } from "react-router-dom";

export default function ApprovalDetail() {
  const { id } = useParams();
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Approval Details</h1>
      <p className="text-muted-foreground">Request ID: {id}</p>
    </div>
  );
}
