/** Red superscript star after the label of a required field; screen readers hear "required" instead. */
export function RequiredMark() {
  return (
    <>
      <sup aria-hidden="true" className="ml-0.5 text-sm font-bold text-destructive">*</sup>
      <span className="sr-only"> (required)</span>
    </>
  );
}
