import { OtpVerifyCard } from "@/components/OtpVerifyCard";
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
  return (
    <OtpVerifyCard
      title="Verify it's you"
      intro="To protect your details, we'll send a one-time password (OTP) to the mobile number on this request."
      sentText={(sentTo) => `Enter the 6-digit OTP sent to the mobile number ${sentTo}.`}
      onSend={() => sendTrackOtp(query)}
      onVerify={(otp) => verifyTrackOtp(query, otp)}
      onVerified={onVerified}
      resetKey={query}
    />
  );
}
