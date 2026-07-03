import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Pencil, MoreVertical, Power, PowerOff, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";

type UserRow = {
  id: string;
  name: string;
  mobile: string;
  roles: string[];
  center_id: string | null;
  is_active: boolean;
  last_login: string | null;
};

const roleColorMap: Record<string, string> = {
  master_admin: "bg-purple-100 text-purple-700 border-purple-200",
  center_manager: "bg-primary/10 text-primary border-primary/20",
  approver: "bg-warning/10 text-warning border-warning/20",
  asset_manager: "bg-info/10 text-info border-info/20",
};
const roleLabelMap: Record<string, string> = {
  master_admin: "Master Admin",
  approver: "Approver",
  center_manager: "Center Manager",
  asset_manager: "Asset Manager",
};
function roleColor(name: string) { return roleColorMap[name] ?? "bg-muted text-muted-foreground border-border"; }
function roleLabel(name: string) { return roleLabelMap[name] ?? name.replace(/_/g, " "); }

const SYSTEM_ROLES = [
  { id: "master_admin", name: "master_admin", description: "Full system access" },
  { id: "asset_manager", name: "asset_manager", description: "Manage inventory and assets" },
  { id: "center_manager", name: "center_manager", description: "Manage center operations" },
  { id: "approver", name: "approver", description: "Review and approve requests" },
] as const;

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  try {
    const parsed = JSON.parse(error.message) as { detail?: string };
    return parsed.detail || error.message || fallback;
  } catch {
    return error.message || fallback;
  }
}

export default function UsersPage() {
  const { can } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  const [filterRole, setFilterRole] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [resolvedPermissions, setResolvedPermissions] = useState<string[]>([]);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [form, setForm] = useState({ fullName: "", mobile: "", roles: ["center_manager"] as string[], assignedCenter: "", isActive: true });

  useEffect(() => {
    async function load() {
      try {
        const [usersResp, centersResp] = await Promise.all([
          apiFetch<UserRow[]>("/api/v1/users?include_inactive=true"),
          apiFetch<Array<{ id: string; name: string }>>("/api/v1/centers"),
        ]);
        setUsers(usersResp);
        setCenters(centersResp);
      } catch (error) {
        console.error("Failed to load users:", error);
        toast.error(getApiErrorMessage(error, "Could not load users"));
      }
    }
    load();
  }, []);

  const filtered = useMemo(() => {
    return filterRole === "all" ? users : users.filter((u) => u.roles.includes(filterRole));
  }, [users, filterRole]);

  const handleSave = async () => {
    if (!form.fullName || !form.mobile || form.roles.length === 0) { toast.error("Please fill required fields"); return; }
    try {
      const payload = {
        name: form.fullName,
        mobile: form.mobile,
        roles: form.roles,
        center_id: form.roles.some(r => r === "center_manager" || r === "asset_manager") ? (form.assignedCenter || null) : null,
        is_active: form.isActive,
      };
      if (editingUserId) {
        const updated = await apiFetch<UserRow>(`/api/v1/users/${editingUserId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
        toast.success("User updated successfully");
      } else {
        const created = await apiFetch<UserRow>("/api/v1/users", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setUsers((prev) => [created, ...prev]);
        toast.success("User added successfully");
      }
      setModalOpen(false);
      setEditingUserId(null);
      setForm({ fullName: "", mobile: "", roles: ["center_manager"], assignedCenter: "", isActive: true });
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Failed to save user"));
    }
  };

  const toggleActive = async (user: UserRow) => {
    try {
      const updated = await apiFetch<UserRow>(`/api/v1/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !user.is_active }),
      });
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      toast.success(user.is_active ? "User deactivated" : "User reactivated");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Failed to update user status"));
    }
  };

  const openEdit = useCallback(async (user: UserRow) => {
    setEditingUserId(user.id);
    setForm({
      fullName: user.name,
      mobile: user.mobile,
      roles: [...user.roles],
      assignedCenter: user.center_id ?? "",
      isActive: user.is_active,
    });
    setPermissionsOpen(false);
    setResolvedPermissions([]);
    setModalOpen(true);
    // Note: Individual user permissions are not available via backend API
    // Only current user permissions are available via /me endpoint
  }, []);

  const centerNameById = Object.fromEntries(centers.map((c) => [c.id, c.name]));

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="w-full sm:w-[180px]"><SelectValue placeholder="All Roles" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            {SYSTEM_ROLES.map((r) => <SelectItem key={r.name} value={r.name}>{roleLabel(r.name)}</SelectItem>)}
          </SelectContent>
        </Select>
        {can("users.manage") && (
          <Button onClick={() => { setEditingUserId(null); setForm({ fullName: "", mobile: "", roles: ["center_manager"], assignedCenter: "", isActive: true }); setModalOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" /> Add New User
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="hidden md:block overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Full Name</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden md:table-cell">Assigned Center</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Last Login</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((user) => (
                <TableRow key={user.id} className={cn(!user.is_active && "opacity-60")}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {user.name}
                      {!user.is_active && (
                        <Badge variant="outline" className="bg-muted text-muted-foreground border-border text-[10px] px-1.5 py-0">
                          Inactive
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">{user.mobile}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map(r => (
                        <Badge key={r} variant="outline" className={cn("border", roleColor(r))}>
                          {roleLabel(r)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">{user.center_id ? centerNameById[user.center_id] ?? "Unknown" : "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("border", user.is_active ? "bg-success/10 text-success border-success/20" : "bg-muted text-muted-foreground border-border")}>
                      {user.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground">{user.last_login ? new Date(user.last_login).toLocaleString("en-IN") : "Never"}</TableCell>
                  <TableCell className="text-right">
                    {can("users.manage") && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(user)}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void toggleActive(user)}>
                            {user.is_active ? (
                              <><PowerOff className="h-3.5 w-3.5 mr-2" /> Deactivate</>
                            ) : (
                              <><Power className="h-3.5 w-3.5 mr-2" /> Reactivate</>
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No users found</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>

          <div className="md:hidden space-y-3 p-4">
            {filtered.map((user) => (
              <div key={user.id} className={cn("rounded-lg border bg-card p-4 space-y-3", !user.is_active && "opacity-60")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">{user.name}</p>
                    <p className="font-mono text-sm text-muted-foreground">{user.mobile}</p>
                  </div>
                  <Badge variant="outline" className={cn("border", user.is_active ? "bg-success/10 text-success border-success/20" : "bg-muted text-muted-foreground border-border")}>
                    {user.is_active ? "Active" : "Inactive"}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {user.roles.map((r) => (
                    <Badge key={r} variant="outline" className={cn("border", roleColor(r))}>
                      {roleLabel(r)}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  Center: <span className="text-foreground">{user.center_id ? centerNameById[user.center_id] ?? "Unknown" : "Unassigned"}</span>
                </p>
                {can("users.manage") && (
                  <div className="flex flex-col gap-2">
                    <Button variant="outline" className="w-full justify-start" onClick={() => openEdit(user)}>
                      <Pencil className="h-4 w-4 mr-2" />
                      Edit user
                    </Button>
                    <Button variant="outline" className="w-full justify-start" onClick={() => void toggleActive(user)}>
                      {user.is_active ? (
                        <>
                          <PowerOff className="h-4 w-4 mr-2" />
                          Deactivate
                        </>
                      ) : (
                        <>
                          <Power className="h-4 w-4 mr-2" />
                          Reactivate
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">No users found</div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Edit/Add User Dialog */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="w-full max-w-lg mx-4 md:mx-auto">
          <DialogHeader><DialogTitle>{editingUserId ? "Edit User" : "Add New User"}</DialogTitle><DialogDescription>Create or update a system user</DialogDescription></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2"><Label>Full Name *</Label><Input placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></div>
            <div className="space-y-2"><Label>Mobile Number *</Label><Input placeholder="10-digit number" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></div>
            <div className="space-y-2">
              <Label>Roles *</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border rounded-md p-4">
                {SYSTEM_ROLES.map((r) => (
                  <div key={r.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`role-${r.id}`}
                      checked={form.roles.includes(r.name)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setForm({ ...form, roles: [...form.roles, r.name] });
                        } else {
                          setForm({ ...form, roles: form.roles.filter(role => role !== r.name) });
                        }
                      }}
                    />
                    <label
                      htmlFor={`role-${r.id}`}
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {roleLabel(r.name)}
                    </label>
                  </div>
                ))}
              </div>
            </div>
            {form.roles.some(r => r === "center_manager" || r === "asset_manager") && (
              <div className="space-y-2">
                <Label>Assigned Center</Label>
                <Select value={form.assignedCenter} onValueChange={(v) => setForm({ ...form, assignedCenter: v })}>
                  <SelectTrigger><SelectValue placeholder="Select center" /></SelectTrigger>
                  <SelectContent>{centers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-center justify-between"><Label>Is Active</Label><Switch checked={form.isActive} onCheckedChange={(v) => setForm({ ...form, isActive: v })} /></div>
            {editingUserId && resolvedPermissions.length > 0 && (
              <div className="border rounded-md p-3">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-sm font-medium w-full text-left"
                  onClick={() => setPermissionsOpen(!permissionsOpen)}
                >
                  {permissionsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  Resolved permissions ({resolvedPermissions.length})
                </button>
                {permissionsOpen && (
                  <p className="text-xs text-muted-foreground mt-2">
                    This user can: {resolvedPermissions.join(", ")}
                  </p>
                )}
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <Button onClick={() => void handleSave()} className="flex-1 w-full md:w-auto">{editingUserId ? "Update User" : "Save User"}</Button>
              <Button variant="outline" onClick={() => { setModalOpen(false); setEditingUserId(null); }} className="flex-1 w-full md:w-auto">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
