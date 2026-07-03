import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Stethoscope, Shield, Package, Building2, CheckCircle } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { getRoleViewPath } from "@/lib/roleRouting";

const roleViewConfig: Record<string, { label: string; description: string; icon: typeof Stethoscope; path: string }> = {
  master_admin: { label: "Master Admin", description: "Full system access", icon: Shield, path: getRoleViewPath("master_admin") ?? "/admin/dashboard" },
  asset_manager: { label: "Asset Manager", description: "Manage categories, assets, and allocations", icon: Package, path: getRoleViewPath("asset_manager") ?? "/admin/assets" },
  center_manager: { label: "Center Manager", description: "Center operations and requests", icon: Building2, path: getRoleViewPath("center_manager") ?? "/center/dashboard" },
  approver: { label: "Approver", description: "Review and approve requests", icon: CheckCircle, path: getRoleViewPath("approver") ?? "/approvals" },
};

export default function ViewSelector() {
  const navigate = useNavigate();
  const { user, setActiveRole } = useAuth();

  if (!user) return null;

  if (user.roles.length === 1) {
    const onlyRole = user.roles[0];
    const config = onlyRole ? roleViewConfig[onlyRole] : null;
    if (config) {
      return <NavigateToRole path={config.path} />;
    }
  }

  const handleSelect = (role: string) => {
    setActiveRole(role);
    const config = roleViewConfig[role];
    if (config) navigate(config.path, { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-primary/10 via-primary/5 to-background">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <BrandLogo className="mb-4 justify-center" imageClassName="h-24 max-w-80" />
          <h2 className="text-lg font-semibold text-foreground">Choose your view</h2>
          <p className="text-sm text-muted-foreground">You have multiple roles. Select how you'd like to work today.</p>
        </div>

        <div className="grid gap-3">
          {user.roles.map((role) => {
            const config = roleViewConfig[role];
            if (!config) return null;
            const Icon = config.icon;
            return (
              <Card
                key={role}
                className="cursor-pointer hover:shadow-md hover:border-primary/50 transition-all"
                onClick={() => handleSelect(role)}
              >
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{config.label}</p>
                    <p className="text-sm text-muted-foreground">{config.description}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NavigateToRole({ path }: { path: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(path, { replace: true });
  }, [navigate, path]);

  return null;
}
