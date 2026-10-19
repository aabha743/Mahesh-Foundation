import { useEffect, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

type Props = {
  title: string;
  /** Shown before the OTP is sent. */
  intro: ReactNode;
  /** Shown once it is sent; `sentTo` is e.g. "ending 93". */
  sentText: (sentTo: string) => ReactNode;
  onSend: () => Promise<{ sent_to: string; resend_in: number }>;
  /** Resolves if the code is right; throws with the message to show otherwise. */
  onVerify: (otp: string) => Promise<unknown>;
  onVerified: () => void;
  /** Changing it starts over (e.g. a different token or request). */
  resetKey: string;
};

/** Send an OTP by SMS, then enter and check it. Used for public tracking and for device handover. */
export function OtpVerifyCard({ title, intro, sentText, onSend, onVerify, onVerified, resetKey }: Props) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    setSentTo(null);
    setOtp("");
    setError("");
    setResendIn(0);
  }, [resetKey]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  async function send() {
    setBusy(true);
    setError("");
    try {
      const result = await onSend();
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
      await onVerify(otp);
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
            <p className="font-medium text-foreground">{title}</p>
            <p className="text-sm text-muted-foreground">{sentTo ? sentText(sentTo) : intro}</p>
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
