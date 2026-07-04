import { useState } from "react";
import { Phone, LogIn, Search, CalendarClock, Menu } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { BRAND, emergencyContactText } from "@/lib/brand";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function PublicHeader() {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const goTo = (path: string) => {
    setMenuOpen(false);
    navigate(path);
  };

  return (
    <header className="bg-card border-b border-border">
      <div className="max-w-5xl mx-auto px-4 py-3">
        <div className="hidden sm:flex sm:items-center sm:justify-between sm:gap-6">
          <button onClick={() => navigate("/")} className="flex items-center gap-2 min-w-0">
            <BrandLogo imageClassName="h-20 max-w-72" />
          </button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate("/status")} className="gap-1.5 min-h-10 px-4">
              <Search className="h-3.5 w-3.5" />
              <span>Track Token Status</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/status")} className="gap-1.5 min-h-10 px-4">
              <CalendarClock className="h-3.5 w-3.5" />
              <span>Extend Existing Lease</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/login")} className="gap-1.5 min-h-10 px-4">
              <LogIn className="h-3.5 w-3.5" />
              <span>Staff Login</span>
            </Button>
          </div>
        </div>

        <div className="sm:hidden flex items-center justify-between gap-3">
          <button onClick={() => navigate("/")} className="flex items-center gap-2 min-w-0">
            <BrandLogo imageClassName="h-14 max-w-52" />
          </button>

          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetContent side="right" className="w-[min(100vw,20rem)] flex flex-col">
              <SheetHeader className="text-left pr-8">
                <SheetTitle>Menu</SheetTitle>
                <SheetDescription>Track a request, extend a lease, or sign in as staff.</SheetDescription>
              </SheetHeader>

              <nav className="flex flex-col gap-2 mt-6">
                <Button
                  variant="secondary"
                  className="w-full justify-start gap-2 min-h-11"
                  onClick={() => goTo("/status")}
                >
                  <Search className="h-4 w-4 shrink-0" />
                  Track Token Status
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-2 min-h-11"
                  onClick={() => goTo("/status")}
                >
                  <CalendarClock className="h-4 w-4 shrink-0" />
                  Extend Existing Lease
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2 min-h-11"
                  onClick={() => goTo("/login")}
                >
                  <LogIn className="h-4 w-4 shrink-0" />
                  Staff Login
                </Button>
              </nav>

              <div className="mt-auto pt-6 border-t border-border">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  <div>
                    <p className="text-xs">Emergency contact</p>
                    <p className="text-sm font-medium text-foreground">{emergencyContactText()}</p>
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="bg-muted/50 border-t border-border mt-auto">
      <div className="max-w-5xl mx-auto px-4 py-6 text-center text-xs text-muted-foreground space-y-1">
        <p className="leading-relaxed">
          Emergency contact: <span className="text-sm font-medium text-foreground">{emergencyContactText()}</span>
          {BRAND.contactEmail && (
            <>
              <span className="hidden sm:inline"> | </span>
              <span className="block sm:inline">
                Email: <span className="font-medium text-foreground">{BRAND.contactEmail}</span>
              </span>
            </>
          )}
        </p>
        <p className="text-xs">&copy; {new Date().getFullYear()} {BRAND.foundationName}. All rights reserved.</p>
      </div>
    </footer>
  );
}
