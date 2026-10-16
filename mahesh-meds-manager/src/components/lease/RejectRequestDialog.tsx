import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Props = {
  /** Token of the request being rejected; null closes the dialog. */
  token: string | null;
  submitting?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Confirmation before rejecting a lease request. No reason is asked for or shown to the requester. */
export function RejectRequestDialog({ token, submitting = false, onCancel, onConfirm }: Props) {
  return (
    <AlertDialog open={!!token} onOpenChange={(open) => !open && !submitting && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reject request {token}?</AlertDialogTitle>
          <AlertDialogDescription>
            The requester will get an SMS saying the request could not be approved. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={submitting}
            onClick={(e) => {
              // Keep the dialog open until the caller has finished (it closes it by clearing the token).
              e.preventDefault();
              onConfirm();
            }}
          >
            {submitting ? "Rejecting..." : "Reject request"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
