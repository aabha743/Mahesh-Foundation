import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  imageClassName?: string;
  showText?: boolean;
  textClassName?: string;
  subtitle?: string;
};

export function BrandLogo({
  className,
  imageClassName,
  showText = false,
  textClassName,
  subtitle,
}: BrandLogoProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <img
        src={BRAND.logoSrc}
        alt={`${BRAND.appName} logo`}
        className={cn("h-12 w-auto shrink-0 rounded bg-white object-contain", imageClassName)}
      />
      {showText && (
        <div className={cn("min-w-0 text-left", textClassName)}>
          <h1 className="truncate text-sm font-bold leading-tight text-foreground">{BRAND.appName}</h1>
          <p className="truncate text-[10px] leading-tight text-muted-foreground">
            {subtitle ?? BRAND.foundationName}
          </p>
        </div>
      )}
    </div>
  );
}
