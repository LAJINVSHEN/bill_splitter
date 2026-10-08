/** What deleting a bill does: the same words on Summary and in Bills history. */
export function DeleteBillNote({ all = false }: { all?: boolean }) {
  return (
    <>
      <p>
        {all
          ? 'All bills, drafts and previously deleted history, across every page and filter, will be permanently erased.'
          : 'This bill’s items, splits and payment history will be permanently erased.'}
      </p>
      <p>Share links stop working, scans are cancelled, and photos are queued for deletion. Scan usage still counts toward your quota. This cannot be undone.</p>
    </>
  )
}
