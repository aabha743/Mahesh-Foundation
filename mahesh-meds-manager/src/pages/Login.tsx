import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Phone, Shield } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { ApiError, requestOTP, verifyOTP, getMe, type MeResponse } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { getRoleViewPath } from "@/lib/roleRouting";

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [otpValiditySeconds, setOtpValiditySeconds] = useState(300);
  const [loading, setLoading] = useState(false);
  const [debugOtp, setDebugOtp] = useState<string | null>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const handleSendOtp = useCallback(async () => {
    setError("");
    const digits = phone.replace(/\D/g, "");
    if (digits.length !== 10) {
      setError("Please enter a valid 10-digit mobile number");
      return;
    }

    setLoading(true);
    try {
      const response = await requestOTP(digits);
      setStep("otp");
      setCountdown(60);
      setOtpValiditySeconds(response.expires_in || 300);
      setDebugOtp(response.debug_otp ?? null);
    } catch (err) {
      // 429 carries the reason: the 60-second wait, the hourly or daily limit, this device's limit, or a lock.
      setError(err instanceof Error && err.message ? err.message : "Failed to send OTP");
    } finally {
      setLoading(false);
    }
  }, [phone]);

  const handleVerify = useCallback(async () => {
    setError("");
    if (otp.length !== 6) {
      setError("Please enter the complete 6-digit OTP");
      return;
    }

    setLoading(true);
    try {
      const digits = phone.replace(/\D/g, "");
      await verifyOTP(digits, otp);

      const user: MeResponse = await getMe();
      login(user);

      await new Promise((resolve) => setTimeout(resolve, 100));

      if (user.roles.length > 1) {
        navigate("/view-selector", { replace: true });
      } else {
        const onlyRole = user.roles[0] ?? "master_admin";
        navigate(getRoleViewPath(onlyRole) ?? "/admin/dashboard", { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        // The code was cancelled after 5 wrong tries, the number is locked, or this device entered too many wrong codes.
        setError(err.message);
        setStep("phone");
        setOtp("");
        setDebugOtp(null);
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Invalid OTP. Please try again.");
        setOtp("");
      } else {
        setError(err instanceof Error && err.message ? err.message : "Invalid OTP");
      }
    } finally {
      setLoading(false);
    }
  }, [otp, phone, login, navigate]);

  const handleResend = () => {
    setOtp("");
    setError("");
    void handleSendOtp();
  };

  const goHome = () => {
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-primary/10 via-primary/5 to-background">
      <Card className="w-full max-w-md shadow-lg border-border/50">
        <CardHeader className="text-center pb-2 pt-8">
          <BrandLogo className="mb-4 justify-center" imageClassName="h-24 max-w-80" />
          <p className="text-xs text-muted-foreground">Staff Login Only</p>
          <p className="text-sm text-muted-foreground mt-2">
            {step === "phone"
              ? "Sign in with your registered mobile number"
              : `If +91 ${phone} is a registered staff number, an OTP has been sent to it.`}
          </p>
        </CardHeader>

        <CardContent className="pt-4 pb-8 px-6 space-y-5">
          <Button variant="outline" onClick={goHome} className="w-full">
            Back to Home
          </Button>
          {step === "phone" ? (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Mobile Number</label>
                <div className="flex gap-2">
                  <div className="flex items-center gap-1.5 px-3 rounded-md border border-input bg-muted text-sm text-muted-foreground shrink-0">
                    <span>+91</span>
                  </div>
                  <Input
                    type="tel"
                    placeholder="Enter 10-digit number"
                    value={phone}
                    onChange={(e) => { setPhone(e.target.value); setError(""); }}
                    maxLength={10}
                    className="flex-1"
                  />
                </div>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={handleSendOtp} disabled={loading} className="w-full" size="lg">
                <Phone className="h-4 w-4 mr-2" />
                {loading ? "Sending..." : "Send OTP"}
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-3">
                <label className="text-sm font-medium text-foreground">Enter OTP</label>
                <div className="flex justify-center">
                  <InputOTP
                    maxLength={6}
                    value={otp}
                    onChange={(val) => { setOtp(val); setError(""); }}
                    inputMode="numeric"
                    pattern="[0-9]*"
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                <p className="text-xs text-center text-muted-foreground">
                  OTP valid for <span className="font-semibold text-foreground">{formatCountdown(otpValiditySeconds)}</span>
                </p>
                {debugOtp && (
                  <p className="text-xs text-center text-muted-foreground mt-1">
                    Dev OTP: <span className="font-mono font-semibold text-foreground">{debugOtp}</span>
                  </p>
                )}
              </div>
              {error && <p className="text-sm text-destructive text-center">{error}</p>}
              <Button onClick={handleVerify} disabled={loading} className="w-full" size="lg">
                <Shield className="h-4 w-4 mr-2" />
                {loading ? "Verifying..." : "Verify & Login"}
              </Button>
              <div className="text-center">
                {countdown > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Resend OTP in <span className="font-semibold text-foreground">{formatCountdown(countdown)}</span>
                  </p>
                ) : (
                  <button onClick={handleResend} className="text-sm text-primary font-medium hover:underline">
                    Resend OTP
                  </button>
                )}
              </div>
              <button
                onClick={() => { setStep("phone"); setOtp(""); setError(""); setDebugOtp(null); }}
                className="w-full text-sm text-muted-foreground hover:text-foreground"
              >
                &larr; Change number
              </button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
