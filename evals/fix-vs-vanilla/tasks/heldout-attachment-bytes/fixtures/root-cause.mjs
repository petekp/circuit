// Attachment handling for approval packets.
//
// Contract for attachment data in this module: an attachment's `data`
// field holds base64 text. The size of an attachment means the byte
// count of the decoded content, not the character count of the base64
// text. Size figures anywhere in this module are decoded bytes.

// Decoded byte count of one attachment's base64 `data` text.
function decodedBytes(data) {
  return Buffer.from(data, 'base64').length;
}

/**
 * Attachments too big to route for sign-off. The pre-flight panel
 * blocks a packet while any attachment is over the per-file cap.
 */
export function oversizedAttachments(attachments, capBytes) {
  return attachments.filter((record) => decodedBytes(record.data) > capBytes);
}

/**
 * Whether a packet's combined attachments stay inside the retention
 * archive's per-packet budget, for the export-to-archive step.
 */
export function withinArchiveBudget(attachments, budgetBytes) {
  let total = 0;
  for (const attachment of attachments) {
    total += Buffer.byteLength(attachment.data, 'base64');
  }
  return total <= budgetBytes;
}
