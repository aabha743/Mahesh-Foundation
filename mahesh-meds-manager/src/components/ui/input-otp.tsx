import React from "react";
import { OTPInput, SlotProps } from "input-otp";

export const InputOTP = React.forwardRef<
  React.ElementRef<typeof OTPInput>,
  React.ComponentPropsWithoutRef<typeof OTPInput>
>(({ className, containerClassName, ...props }, ref) => (
  <OTPInput
    ref={ref}
    containerClassName={`flex items-center gap-2 ${containerClassName || ""}`}
    className={className}
    {...props}
  />
));
InputOTP.displayName = "InputOTP";

export const InputOTPGroup = ({ children, className }: { children?: React.ReactNode; className?: string }) => (
  <div className={`flex items-center ${className || ""}`}>{children}</div>
);

export const InputOTPSlot = React.forwardRef<
  HTMLDivElement,
  SlotProps & { className?: string }
>(({ char, hasFakeCaret, isActive, className }, ref) => (
  <div
    ref={ref}
    className={`relative flex h-10 w-10 items-center justify-center border text-sm transition-all rounded-md ${
      isActive ? "z-10 ring-2 ring-ring" : ""
    } ${className || ""}`}
  >
    {char}
    {hasFakeCaret && (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-4 w-px animate-caret-blink bg-foreground duration-1000" />
      </div>
    )}
  </div>
));
InputOTPSlot.displayName = "InputOTPSlot";

export const InputOTPSeparator = () => <div>-</div>;
