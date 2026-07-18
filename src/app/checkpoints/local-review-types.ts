export type LocalCheckpointReviewAsset = {
  /** Opaque graph identity. It is never used as a filesystem path. */
  readonly id: string;
  /** Exact generated review-page URL values that open this captured asset. */
  readonly pageReferences: readonly LocalCheckpointReviewPageReference[];
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** Exact references inside these bytes, resolved during the trusted capture. */
  readonly references: readonly LocalCheckpointReviewAssetReference[];
};

export type LocalCheckpointReviewPageReference = {
  readonly sourceUrl: string;
  /** Existing renderer proof expected by the outer review page. */
  readonly previewProof?: string | undefined;
};

export type LocalCheckpointReviewAssetReference = {
  readonly kind: 'html-attribute' | 'html-srcset' | 'css-url';
  readonly sourceValue: string;
  readonly targetId: string;
};
