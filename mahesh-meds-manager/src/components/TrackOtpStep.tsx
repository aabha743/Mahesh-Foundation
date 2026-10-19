import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { sendTrackOtp, verifyTrackOtp } from "@/lib/api";

type Props = {
  /** The token or mobile number the visitor entered. */
  query: string;
  /** Called once the OTP is verified; the browser then has a 30-minute tracking session. */
  onVerified: () => void;
};

/**
 * Before showing a request, the public verify the request's mobile number: an OTP is texted to it and
 * entered here. Used by the status page and the extension form.
 */
export function TrackOtpStep({ query, onVerified }: Props) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // A new token or number starts over.
  useEffect(() => {
    setSentTo(null);
    setOtp("");
    setError("");
    setResendIn(0);
  }, [query]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  async function send() {
    setBusy(true);
    setError("");
    try {
      const result = await sendTrackOtp(query);
      setSentTo(result.sent_to);
      setOtp("");
      setResendIn(result.resend_in);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the OTP. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (otp.length !== 6) return;
    setBusy(true);
    setError("");
    try {
      await verifyTrackOtp(query, otp);
      onVerified();
    } catch (e) {
      setOtp("");
      setError(e instanceof Error ? e.message : "Could not verify the OTP. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="py-6 space-y-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-6 w-6 shrink-0 text-primary" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Verify it's you</p>
            <p className="text-sm text-muted-foreground">
              {sentTo
                ? `Enter the 6-digit OTP sent to the mobile number ${sentTo}.`
                : "To protect your details, we'll send a one-time password (OTP) to the mobile number on this request."}
            </p>
          </div>
        </div>

        {sentTo ? (
          <div className="space-y-3">
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={otp}
                onChange={(value) => {
                  setOtp(value);
                  setError("");
                }}
                onComplete={() => void verify()}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                aria-label="One-time password"
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <InputOTPSlot key={index} index={index} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button className="w-full min-h-12" onClick={() => void verify()} disabled={busy || otp.length !== 6}>
              {busy ? "Verifying..." : "Verify OTP"}
            </Button>
            <Button variant="ghost" className="w-full" onClick={() => void send()} disabled={busy || resendIn > 0}>
              {resendIn > 0 ? `Resend OTP in ${resendIn}s` : "Resend OTP"}
            </Button>
          </div>
        ) : (
          <Button className="w-full min-h-12" onClick={() => void send()} disabled={busy}>
            {busy ? "Sending..." : "Send OTP"}
          </Button>
        )}

        {error && <p className="text-sm text-destructive text-center">{error}</p>}
      </CardContent>
    </Card>
  );
}
