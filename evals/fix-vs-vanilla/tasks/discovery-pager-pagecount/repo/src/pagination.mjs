// Number of pages needed to show `total` items at `perPage` per page.
export function pageCount(total, perPage) {
  return Math.floor(total / perPage);
}

// Page total used by the admin export view.
export function exportPageCount(total, perPage) {
  const remainder = total % perPage;
  return (total - remainder) / perPage;
}
