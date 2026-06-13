// Attachment handling for approval packets.
//
// Contract for attachment data in this module: an attachment's `data`
// field holds base64 text. The size of an attachment means the byte
// count of the decoded content, not the character count of the base64
// text. Size figures anywhere in this module are decoded bytes.

/**
 * Attachments too big to route for sign-off. The pre-flight panel
 * blocks a packet while any attachment is over the per-file cap.
 */
export function oversizedAttachments(attachments, capBytes) {
  return attachments.filter((record) => Buffer.from(record.data, 'base64').length > capBytes);
}

/**
 * Whether a packet's combined attachments stay inside the retention
 * archive's per-packet budget, for the export-to-archive step.
 */
export function withinArchiveBudget(attachments, budgetBytes) {
  let total = 0;
  for (const attachment of attachments) {
    total += Buffer.byteLength(attachment.data);
  }
  return total <= budgetBytes;
}
