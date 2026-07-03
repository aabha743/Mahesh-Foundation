import { describe, expect, it } from "vitest";

import { getRoleViewPath, resolveAdminHome, resolveAuthenticatedHome } from "./roleRouting";

describe("role routing", () => {
  it("maps each supported role to a stable view path", () => {
    expect(getRoleViewPath("master_admin")).toBe("/admin/dashboard");
    expect(getRoleViewPath("asset_manager")).toBe("/admin/assets");
    expect(getRoleViewPath("center_manager")).toBe("/center/dashboard");
    expect(getRoleViewPath("approver")).toBe("/approvals");
  });

  it("routes master_admin + center_manager based on active role", () => {
    const roles = ["master_admin", "center_manager"];
    const permissions = ["users.manage", "devices.issue", "devices.collect", "assets.transfer"];

    expect(resolveAuthenticatedHome({ activeRole: "master_admin", roles, permissions })).toBe("/admin/dashboard");
    expect(resolveAuthenticatedHome({ activeRole: "center_manager", roles, permissions })).toBe("/center/dashboard");
  });

  it("routes master_admin + approver based on active role", () => {
    const roles = ["master_admin", "approver"];
    const permissions = ["users.manage", "requests.approve", "requests.reject", "requests.edit"];

    expect(resolveAuthenticatedHome({ activeRole: "master_admin", roles, permissions })).toBe("/admin/dashboard");
    expect(resolveAuthenticatedHome({ activeRole: "approver", roles, permissions })).toBe("/approvals");
  });

  it("routes asset_manager + approver based on active role", () => {
    const roles = ["asset_manager", "approver"];
    const permissions = ["assets.create", "assets.update", "requests.approve", "requests.reject"];

    expect(resolveAuthenticatedHome({ activeRole: "asset_manager", roles, permissions })).toBe("/admin/assets");
    expect(resolveAuthenticatedHome({ activeRole: "approver", roles, permissions })).toBe("/approvals");
  });

  it("routes asset_manager + center_manager based on active role", () => {
    const roles = ["asset_manager", "center_manager"];
    const permissions = ["assets.create", "assets.update", "devices.issue", "devices.collect", "assets.transfer"];

    expect(resolveAuthenticatedHome({ activeRole: "asset_manager", roles, permissions })).toBe("/admin/assets");
    expect(resolveAuthenticatedHome({ activeRole: "center_manager", roles, permissions })).toBe("/center/dashboard");
  });

  it("keeps admin home redirect aligned with active role", () => {
    expect(
      resolveAdminHome({
        activeRole: "asset_manager",
        roles: ["asset_manager", "master_admin"],
        permissions: ["assets.create", "assets.update", "users.manage"],
      }),
    ).toBe("/admin/assets");

    expect(
      resolveAdminHome({
        activeRole: "master_admin",
        roles: ["asset_manager", "master_admin"],
        permissions: ["assets.create", "assets.update", "users.manage"],
      }),
    ).toBe("/admin/dashboard");
  });
});
