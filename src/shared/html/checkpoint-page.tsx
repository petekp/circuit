// Shared checkpoint page renderer.
//
// A waiting checkpoint is a decision surface, not a report: the operator
// must be able to answer four questions from the page alone — what is being
// asked, what are the options, what happens if I do nothing, and how do I
// respond. renderCheckpointPage renders that shape for every flow; flow
// projectors feed it richer option bodies and context sections, and
// genericCheckpointHtml renders it straight from the projector context so
// a waiting run always has a page even when no flow projector exists.
//
// Rendered with the vendored design system (src/shared/html/ui) through
// the React document shell; output is static, single-file HTML.

import type { ReactNode } from 'react';

import {
  ARTIFACT_PREVIEW_SCRIPT,
  ARTIFACT_PREVIEW_STYLE,
  type ArtifactPreview,
  ArtifactPreviewFrame,
} from './artifact-preview.js';
import { CHECKPOINT_REVIEW_RUNTIME } from './checkpoint-review-runtime.generated.js';
import { MAX_PROMPT_LEN, truncate } from './page.js';
import type { HtmlProjectorContext } from './projector.js';
import { renderHtmlDocument, t } from './react-page.js';

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function resumeCommandForChoice(
  runFolder: string,
  choiceId: string,
  commandPrefix = 'circuit resume',
): string {
  return `${commandPrefix} --run-folder ${shellSingleQuote(
    runFolder,
  )} --checkpoint-choice ${shellSingleQuote(choiceId)}`;
}

export type CheckpointPageOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly isRecommended?: boolean | undefined;
  // Flow-specific option body (bullets, evidence chips) as rendered nodes.
  readonly extra?: ReactNode | undefined;
};

export type CheckpointPageInput = {
  readonly meta: {
    readonly flowLabel: string;
    readonly runId: string;
    readonly stepId: string;
  };
  readonly question: string;
  readonly subtitle?: string | undefined;
  readonly ribbon: readonly string[];
  readonly recommendation?:
    | {
        readonly label: string;
        readonly rationale?: string | undefined;
      }
    | undefined;
  readonly options: readonly CheckpointPageOption[];
  readonly defaultChoice?: { readonly id: string; readonly label: string } | undefined;
  readonly artifact?:
    | {
        readonly title: string;
        readonly description?: string | undefined;
        readonly preview: ArtifactPreview;
      }
    | undefined;
  // Flow-specific context (e.g. Build's artifact/risk cards).
  readonly context?: ReactNode | undefined;
  // Trailing section (e.g. a raw-evidence disclosure block).
  readonly appendix?: ReactNode | undefined;
  readonly resume: {
    readonly runFolder: string;
    readonly commandPrefix: string;
    readonly attempt: number;
    readonly requestSha256: string;
  };
  readonly footerLeft?: string | undefined;
  readonly footerRight?: string | undefined;
};

const CHECKPOINT_STYLE = [
  ARTIFACT_PREVIEW_STYLE,
  '.cp-wrap{min-height:100dvh;min-width:0;background:var(--muted);color:var(--foreground);font-size:14px;line-height:1.5}',
  '.cp-skip{position:fixed;left:12px;top:10px;z-index:50;transform:translateY(-150%);border-radius:8px;background:var(--foreground);color:var(--background);padding:9px 12px;font-size:13px}',
  '.cp-skip:focus{transform:translateY(0)}',
  '.cp-shell{width:min(1120px,calc(100% - 32px));min-width:0;margin:0 auto;padding:24px 0 110px}',
  '.cp-shell-artifact{width:min(1280px,calc(100% - 32px))}',
  '.cp-topbar{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:28px}',
  '.cp-brand{font-size:12px;font-weight:650;letter-spacing:.045em;text-transform:uppercase}',
  '.cp-state{display:flex;align-items:center;gap:7px;color:var(--muted-foreground);font-size:12px}',
  '.cp-state::before{content:"";width:7px;height:7px;border-radius:999px;background:var(--positive)}',
  '.cp-hero{min-width:0;max-width:760px;margin-bottom:26px}',
  '.cp-ribbon{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px}',
  '.cp-pill{border:1px solid var(--border);border-radius:999px;background:var(--background);padding:3px 9px;color:var(--muted-foreground);font-size:10px;font-weight:650;letter-spacing:.045em;text-transform:uppercase}',
  '.cp-hero h1{min-width:0;overflow-wrap:anywhere;word-break:break-word;font-size:clamp(25px,3vw,38px);line-height:1.12;font-weight:650;letter-spacing:-.035em;text-wrap:balance}',
  '.cp-subtitle{min-width:0;max-width:650px;margin-top:10px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:15px}',
  '.cp-layout{min-width:0;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(310px,.85fr);gap:18px;align-items:start}',
  '.cp-layout>*{min-width:0}',
  '.cp-layout-artifact{grid-template-columns:minmax(0,1.6fr) minmax(340px,.8fr);grid-template-areas:"artifact choices" "artifact inspector"}',
  '.cp-layout-artifact .cp-artifact{grid-area:artifact}',
  '.cp-layout-artifact #cp-options{grid-area:choices}',
  '.cp-layout-artifact .cp-inspector{grid-area:inspector;position:static}',
  '.cp-card{min-width:0;border:1px solid var(--border);border-radius:16px;background:var(--background);box-shadow:0 1px 2px rgba(0,0,0,.025)}',
  '.cp-artifact{position:sticky;top:18px;overflow:hidden}',
  '.cp-artifact-bar{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 14px;border-bottom:1px solid var(--border)}',
  '.cp-artifact-title{min-width:0}',
  '.cp-artifact-title strong{display:block;overflow-wrap:anywhere;font-size:13px;font-weight:620}',
  '.cp-artifact-title span{display:block;max-width:650px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground);font-size:11px}',
  '.cp-open-link{display:inline-flex;flex:none;align-items:center;justify-content:center;min-height:38px;border:1px solid var(--border);border-radius:9px;background:var(--background);padding:0 11px;color:var(--foreground);font-size:12px;font-weight:580;text-decoration:none}',
  '.cp-artifact-canvas{position:relative;height:clamp(420px,56dvh,620px);min-width:0;background:#fff}',
  '.cp-artifact-note{padding:9px 14px;border-top:1px solid var(--border);color:var(--muted-foreground);font-size:10.5px}',
  '.cp-list-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 18px 10px}',
  '.cp-eyebrow{color:var(--muted-foreground);font-size:10px;font-weight:680;letter-spacing:.065em;text-transform:uppercase}',
  '.cp-list{display:flex;flex-direction:column;gap:8px;padding:8px}',
  '.cp-option{position:relative;width:100%;display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:12px;align-items:start;border:1px solid transparent;border-radius:12px;background:transparent;padding:13px;text-align:left;cursor:pointer}',
  '.cp-native-radio{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}',
  '.cp-option:hover{background:var(--accent)}',
  '.cp-option:has(.cp-native-radio:checked){border-color:var(--border);background:var(--secondary);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--ring) 10%,transparent)}',
  '.cp-option:focus-within{outline:3px solid color-mix(in oklab,var(--ring) 38%,transparent);outline-offset:1px}',
  '.cp-radio{display:grid;place-items:center;width:22px;height:22px;margin-top:1px;border:1.5px solid var(--input);border-radius:999px;background:var(--background)}',
  '.cp-option:has(.cp-native-radio:checked) .cp-radio{border:6px solid var(--foreground)}',
  '.cp-option-copy{min-width:0}',
  '.cp-option-title{display:block;overflow-wrap:anywhere;word-break:break-word;font-size:14px;font-weight:620;line-height:1.35}',
  '.cp-option-description{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;margin-top:4px;overflow:hidden;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:12.5px;line-height:1.45}',
  '.cp-badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}',
  '.cp-badge{border:1px solid var(--border);border-radius:999px;padding:2px 7px;color:var(--muted-foreground);font-size:9px;font-weight:680;letter-spacing:.045em;text-transform:uppercase}',
  '.cp-badge.cp-recommended{border-color:color-mix(in oklab,var(--positive) 48%,var(--border));color:var(--positive)}',
  '.cp-default{margin:5px 18px 17px;padding-top:12px;border-top:1px solid var(--border);color:var(--muted-foreground);font-size:11.5px}',
  '.cp-inspector{position:sticky;top:18px;overflow:hidden}',
  '.cp-inspector-main{padding:20px}',
  '.cp-inspector h2{margin-top:5px;overflow-wrap:anywhere;word-break:break-word;font-size:21px;line-height:1.25;font-weight:640;letter-spacing:-.025em}',
  '.cp-selection-description{margin-top:7px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:13px}',
  '.cp-field-label{display:block;margin:22px 0 7px;font-size:12px;font-weight:620}',
  '.cp-comment{display:block;width:100%;min-height:116px;resize:vertical;border:1px solid var(--input);border-radius:11px;background:var(--background);padding:11px 12px;font:inherit;font-size:13px;line-height:1.45;outline:none}',
  '.cp-comment:focus{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 18%,transparent)}',
  '.cp-save-state{min-height:18px;margin-top:7px;color:var(--muted-foreground);font-size:11px}',
  '.cp-option-detail[hidden]{display:none}',
  '.cp-disclosure{border-top:1px solid var(--border)}',
  '.cp-disclosure summary{display:flex;align-items:center;justify-content:space-between;min-height:46px;padding:0 20px;cursor:pointer;list-style:none;font-size:12.5px;font-weight:590}',
  '.cp-disclosure summary::-webkit-details-marker{display:none}',
  '.cp-disclosure summary::after{content:"+";color:var(--muted-foreground);font-size:17px;font-weight:400}',
  '.cp-disclosure[open] summary::after{content:"−"}',
  '.cp-disclosure-body{min-width:0;padding:0 20px 18px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:12.5px}',
  '.cp-disclosure-body [data-slot="card"]{box-shadow:none}',
  '.cp-footer{position:fixed;left:0;right:0;bottom:0;z-index:20;border-top:1px solid var(--border);background:color-mix(in oklab,var(--background) 94%,transparent);backdrop-filter:blur(18px)}',
  '.cp-footer-inner{width:min(1120px,calc(100% - 32px));min-width:0;min-height:74px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:20px}',
  '.cp-footer-choice{min-width:0;flex:1}',
  '.cp-footer-choice small{display:block;color:var(--muted-foreground);font-size:10px;text-transform:uppercase;letter-spacing:.06em}',
  '.cp-footer-choice strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
  '.cp-primary,.cp-secondary{display:inline-flex;min-width:0;align-items:center;justify-content:center;min-height:42px;border-radius:10px;padding:0 16px;font-size:13px;font-weight:620;cursor:pointer;touch-action:manipulation}',
  '.cp-primary{border:1px solid var(--primary);background:var(--primary);color:var(--primary-foreground)}',
  '.cp-secondary{border:1px solid var(--border);background:var(--background);color:var(--foreground)}',
  '.cp-primary:active,.cp-secondary:active{transform:scale(.98)}',
  '.cp-dialog{position:fixed;inset:0;width:min(540px,calc(100% - 28px));max-height:calc(100dvh - 32px);margin:auto;overflow:auto;border:1px solid var(--border);border-radius:18px;background:var(--background);color:var(--foreground);padding:0;box-shadow:0 24px 80px rgba(0,0,0,.22)}',
  '.cp-dialog::backdrop{background:rgba(0,0,0,.38);backdrop-filter:blur(4px)}',
  '.cp-dialog-body{padding:24px}',
  '.cp-dialog h2{margin-top:5px;overflow-wrap:anywhere;word-break:break-word;font-size:23px;line-height:1.2;font-weight:650;letter-spacing:-.03em}',
  '.cp-dialog-summary{margin-top:8px;color:var(--foreground);font-size:12px;font-weight:600}',
  '.cp-dialog-copy{margin-top:8px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:13px}',
  '.cp-command{display:block;max-height:140px;margin-top:16px;overflow:auto;border:1px solid var(--border);border-radius:9px;background:var(--muted);padding:10px;overflow-wrap:anywhere;white-space:pre-wrap;font:500 10px/1.45 ui-monospace,"SF Mono",Menlo,monospace}',
  '.cp-command-state{min-height:18px;margin-top:8px;color:var(--muted-foreground);font-size:11px}',
  '.cp-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}',
  '.cp-noscript{width:min(760px,calc(100% - 32px));margin:24px auto;border:1px solid var(--border);border-radius:16px;background:var(--background);padding:24px}',
  '.cp-noscript h1{font-size:24px;line-height:1.2;font-weight:650;letter-spacing:-.025em}',
  '.cp-noscript>p{margin-top:8px;color:var(--muted-foreground)}',
  '.cp-noscript-list{display:grid;gap:12px;margin-top:20px}',
  '.cp-noscript-option{min-width:0;border:1px solid var(--border);border-radius:12px;background:var(--muted);padding:15px}',
  '.cp-noscript-artifact{margin-top:20px}',
  '.cp-noscript-option strong{display:block;overflow-wrap:anywhere;font-size:14px}',
  '.cp-noscript-option span,.cp-noscript-option a{display:block;margin-top:3px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:11px}',
  '.cp-noscript code{display:block;margin-top:10px;overflow-wrap:anywhere;white-space:pre-wrap;user-select:all;font:500 13px/1.55 ui-monospace,"SF Mono",Menlo,monospace}',
  '.cp-meta{margin-top:18px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:10px}',
  '.cp-live{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
  '@media(max-width:900px){.cp-layout-artifact{grid-template-columns:1fr;grid-template-areas:"artifact" "choices" "inspector"}.cp-artifact{position:static}.cp-artifact-canvas{height:min(58dvh,540px);min-height:380px}}',
  '@media(max-width:760px){.cp-shell{width:min(100% - 20px,680px);padding-top:16px}.cp-topbar{align-items:flex-start;margin-bottom:20px}.cp-brand,.cp-state{min-width:0;overflow-wrap:anywhere}.cp-layout{grid-template-columns:1fr}.cp-inspector{position:static}.cp-hero h1{font-size:28px}.cp-option{grid-template-columns:28px minmax(0,1fr)}.cp-badges{grid-column:2;justify-content:flex-start}.cp-footer-inner{width:calc(100% - 20px);gap:10px}.cp-primary{flex:none;padding:0 13px}.cp-dialog-actions{flex-direction:column-reverse}.cp-dialog-actions button{width:100%}}',
  '@media(max-width:600px){.cp-artifact-bar{align-items:flex-start}.cp-artifact-title span{white-space:normal}.cp-open-link{min-height:44px}.cp-artifact-canvas{height:52dvh;min-height:350px}.cp-dialog{inset:auto 8px 8px;width:auto;max-height:calc(100dvh - 16px);margin:auto 0 0;border-radius:18px}.cp-dialog-body{padding:20px}.cp-noscript{width:calc(100% - 20px);margin:10px auto;padding:18px}.cp-noscript code{font-size:12px}}',
  '@media(prefers-reduced-motion:no-preference){.cp-option,.cp-primary,.cp-secondary{transition:background-color .16s ease,border-color .16s ease,transform .12s ease}}',
].join('');

function OptionDetail({
  option,
  selected,
}: { readonly option: CheckpointPageOption; readonly selected: boolean }) {
  return (
    <div data-cp-option-detail="" data-cp-choice-id={option.id} hidden={!selected}>
      {option.extra ?? null}
    </div>
  );
}

function CheckpointPage({ input }: { readonly input: CheckpointPageInput }) {
  const selectedIndex = Math.max(
    0,
    input.options.findIndex((option) => option.isRecommended === true || option.isDefault === true),
  );
  const selected = input.options[selectedIndex] ?? input.options[0];
  if (selected === undefined) return null;
  const subtitle =
    input.subtitle ?? 'Review the choices, add context if useful, then prepare your decision.';
  return (
    <div
      className="cp-wrap"
      data-cp-workspace=""
      data-run-folder={input.resume.runFolder}
      data-resume-prefix={input.resume.commandPrefix}
      data-run-id={input.meta.runId}
      data-step-id={input.meta.stepId}
      data-attempt={input.resume.attempt}
      data-request-sha256={input.resume.requestSha256}
    >
      <div data-cp-interactive="">
        <a className="cp-skip" href="#cp-options">
          Skip to choices
        </a>
        <a className="cp-skip" href="#cp-comment">
          Skip to review note
        </a>
        <div className={`cp-shell${input.artifact === undefined ? '' : ' cp-shell-artifact'}`}>
          <header className="cp-topbar">
            <div className="cp-brand">Circuit · {t(input.meta.flowLabel, 120)}</div>
            <div className="cp-state">Waiting for your review</div>
          </header>
          <section className="cp-hero">
            {input.ribbon.length === 0 ? null : (
              <div className="cp-ribbon">
                {input.ribbon.map((tag) => (
                  <span key={tag} className="cp-pill">
                    {t(tag, 120)}
                  </span>
                ))}
              </div>
            )}
            <h1>{t(input.question, MAX_PROMPT_LEN)}</h1>
            <p className="cp-subtitle">{t(subtitle, MAX_PROMPT_LEN)}</p>
          </section>
          <main className={`cp-layout${input.artifact === undefined ? '' : ' cp-layout-artifact'}`}>
            {input.artifact === undefined ? null : (
              <section
                className="cp-card cp-artifact"
                aria-label="Artifact preview"
                data-artifact-preview-panel=""
              >
                <div className="cp-artifact-bar">
                  <div className="cp-artifact-title">
                    <strong>{t(input.artifact.title, MAX_PROMPT_LEN)}</strong>
                    {input.artifact.description === undefined ? null : (
                      <span>{t(input.artifact.description, MAX_PROMPT_LEN)}</span>
                    )}
                  </div>
                  {input.artifact.preview.status === 'ready' ? (
                    <a
                      className="cp-open-link"
                      href={input.artifact.preview.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open full size ↗
                    </a>
                  ) : null}
                </div>
                <div className="cp-artifact-canvas">
                  <ArtifactPreviewFrame
                    preview={input.artifact.preview}
                    title={`${t(input.artifact.title, MAX_PROMPT_LEN)} artifact preview`}
                    eager
                  />
                </div>
                <p className="cp-artifact-note">
                  The embedded preview is isolated for safety. Open it full size if a browser
                  feature is unavailable here.
                </p>
              </section>
            )}
            <section
              className="cp-card"
              id="cp-options"
              aria-labelledby="cp-options-heading"
              tabIndex={-1}
            >
              <div className="cp-list-head">
                <span className="cp-eyebrow" id="cp-options-heading">
                  Choose one
                </span>
                <span className="cp-eyebrow">
                  {input.options.length} {input.options.length === 1 ? 'option' : 'options'}
                </span>
              </div>
              <div className="cp-list" role="radiogroup" aria-label="Checkpoint choices">
                {input.options.map((option, index) => {
                  const isSelected = index === selectedIndex;
                  return (
                    <label key={option.id} className="cp-option">
                      <input
                        className="cp-native-radio"
                        type="radio"
                        name="checkpoint-choice"
                        value={option.id}
                        defaultChecked={isSelected}
                        tabIndex={isSelected ? 0 : -1}
                        data-cp-option=""
                        data-cp-choice-id={option.id}
                        data-cp-label={t(option.label, MAX_PROMPT_LEN)}
                        data-cp-description={t(option.description ?? '', MAX_PROMPT_LEN)}
                      />
                      <span className="cp-radio" aria-hidden="true" />
                      <span className="cp-option-copy">
                        <span className="cp-option-title">{t(option.label, MAX_PROMPT_LEN)}</span>
                        {option.description === undefined ? null : (
                          <span className="cp-option-description">
                            {t(option.description, MAX_PROMPT_LEN)}
                          </span>
                        )}
                      </span>
                      <span className="cp-badges">
                        {option.isRecommended === true ? (
                          <span className="cp-badge cp-recommended">Suggested</span>
                        ) : null}
                        {option.isDefault === true ? (
                          <span className="cp-badge">Default</span>
                        ) : null}
                        <span className="cp-badge" data-cp-note-count="" hidden>
                          0 notes
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="cp-default">
                <strong>If you do nothing: </strong>
                {input.defaultChoice === undefined ? (
                  <>the run stays parked here until you choose.</>
                ) : (
                  <>
                    the run stays parked here. The declared default is{' '}
                    {t(input.defaultChoice.label, MAX_PROMPT_LEN)}.
                  </>
                )}
              </div>
            </section>
            <aside className="cp-card cp-inspector" aria-label="Decision notes">
              <div className="cp-inspector-main">
                <div className="cp-eyebrow">Your current choice</div>
                <h2 data-cp-selected-label="">{t(selected.label, MAX_PROMPT_LEN)}</h2>
                <p
                  className="cp-selection-description"
                  data-cp-selected-description=""
                  hidden={selected.description === undefined}
                >
                  {t(selected.description ?? '', MAX_PROMPT_LEN)}
                </p>
                <label className="cp-field-label" htmlFor="cp-comment">
                  Review note for this choice (optional)
                </label>
                <textarea
                  className="cp-comment"
                  id="cp-comment"
                  data-cp-comment=""
                  maxLength={2000}
                  placeholder="Record why you made this choice."
                />
                <div className="cp-save-state" data-cp-save-state="">
                  Saved in this browser
                </div>
                {input.options.map((option, index) => (
                  <OptionDetail
                    key={option.id}
                    option={option}
                    selected={index === selectedIndex}
                  />
                ))}
              </div>
              {input.recommendation?.rationale === undefined ? null : (
                <details className="cp-disclosure">
                  <summary>
                    Why Circuit suggested {t(input.recommendation.label, MAX_PROMPT_LEN)}
                  </summary>
                  <div className="cp-disclosure-body">
                    {t(input.recommendation.rationale, MAX_PROMPT_LEN)}
                  </div>
                </details>
              )}
              {input.context === undefined ? null : (
                <details className="cp-disclosure">
                  <summary>Review context</summary>
                  <div className="cp-disclosure-body">{input.context}</div>
                </details>
              )}
              {input.appendix === undefined ? null : (
                <details className="cp-disclosure">
                  <summary>Full evidence</summary>
                  <div className="cp-disclosure-body">{input.appendix}</div>
                </details>
              )}
            </aside>
          </main>
          <div className="cp-meta">
            {t(input.footerLeft ?? `circuit · ${input.meta.stepId} · ${input.meta.runId}`, 300)}
            {input.footerRight === undefined ? null : <> · {t(input.footerRight, 300)}</>}
          </div>
        </div>
        <footer className="cp-footer">
          <div className="cp-footer-inner">
            <div className="cp-footer-choice">
              <small>Selected</small>
              <strong data-cp-footer-label="">{t(selected.label, MAX_PROMPT_LEN)}</strong>
            </div>
            <button className="cp-primary" type="button" data-cp-finish="">
              Review decision
            </button>
          </div>
        </footer>
        <dialog
          className="cp-dialog"
          data-cp-dialog=""
          aria-labelledby="cp-dialog-title"
          aria-describedby="cp-dialog-summary cp-dialog-description"
        >
          <div className="cp-dialog-body">
            <div className="cp-eyebrow">Finish review</div>
            <h2 id="cp-dialog-title">
              Choose <span data-cp-confirm-title="">{t(selected.label, MAX_PROMPT_LEN)}</span>?
            </h2>
            <p className="cp-dialog-summary" id="cp-dialog-summary" data-cp-confirm-summary="">
              0 option comments
              {input.options.length > 1 ? ` · ${input.options.length - 1} unvisited` : ''}
            </p>
            <p className="cp-dialog-copy" id="cp-dialog-description">
              Circuit will save your selection and notes with the checkpoint record. Later steps do
              not read these notes automatically.
            </p>
            <label className="cp-field-label" htmlFor="cp-overall-comment">
              Note for the run record (optional)
            </label>
            <textarea
              className="cp-comment"
              id="cp-overall-comment"
              data-cp-overall-comment=""
              maxLength={2000}
              placeholder="Add any context you want saved with this review."
            />
            <code className="cp-command" data-cp-command="" hidden />
            <div
              className="cp-command-state"
              data-cp-command-state=""
              role="status"
              aria-live="polite"
            />
            <div className="cp-dialog-actions">
              <button className="cp-secondary" type="button" data-cp-close-dialog="">
                Keep reviewing
              </button>
              <button className="cp-primary" type="button" data-cp-copy-decision="">
                Copy decision command
              </button>
            </div>
          </div>
        </dialog>
        <div className="cp-live" aria-live="polite" data-cp-live="" />
      </div>
      <noscript>
        <style>{'[data-cp-interactive]{display:none!important}'}</style>
        <div className="cp-noscript">
          <h1>{t(input.question, MAX_PROMPT_LEN)}</h1>
          <p>
            JavaScript is off. These commands record the choice only; comments require the full
            review page.
          </p>
          {input.artifact === undefined ? null : (
            <section className="cp-noscript-option cp-noscript-artifact">
              <strong>{t(input.artifact.title, MAX_PROMPT_LEN)}</strong>
              {input.artifact.description === undefined ? null : (
                <span>{t(input.artifact.description, MAX_PROMPT_LEN)}</span>
              )}
              {input.artifact.preview.status === 'ready' ? (
                <a href={input.artifact.preview.href}>Open artifact</a>
              ) : (
                <span>
                  {input.artifact.preview.status === 'missing'
                    ? 'Preview file missing'
                    : input.artifact.preview.status === 'unsupported'
                      ? 'Preview format unsupported'
                      : 'Preview unavailable'}
                </span>
              )}
            </section>
          )}
          <div className="cp-noscript-list">
            {input.options.map((option) => (
              <section key={option.id} className="cp-noscript-option">
                <strong>{t(option.label, MAX_PROMPT_LEN)}</strong>
                {option.description === undefined ? null : (
                  <span>{t(option.description, MAX_PROMPT_LEN)}</span>
                )}
                {option.isRecommended === true ? <span>Suggested</span> : null}
                {option.isDefault === true ? <span>Declared default</span> : null}
                <code>
                  {truncate(
                    resumeCommandForChoice(
                      t(input.resume.runFolder),
                      option.id,
                      input.resume.commandPrefix,
                    ),
                    MAX_PROMPT_LEN,
                  )}
                </code>
              </section>
            ))}
          </div>
        </div>
      </noscript>
    </div>
  );
}

export function renderCheckpointPage(input: CheckpointPageInput): string {
  if (input.options.length === 0) throw new Error('checkpoint page requires at least one option');
  return renderHtmlDocument({
    title: `${truncate(input.question, 80)} · Circuit ${input.meta.flowLabel} checkpoint`,
    body: <CheckpointPage input={input} />,
    extraStyle: CHECKPOINT_STYLE,
    extraScript: `${CHECKPOINT_REVIEW_RUNTIME}\n${ARTIFACT_PREVIEW_SCRIPT}`,
  });
}

function flowLabelFromId(flowId: string): string {
  return flowId
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

// Renders the generic checkpoint page from the projector context alone.
// This is the writer's structural fallback: it runs for any waiting
// checkpoint whose flow has no projector (or whose projector produced
// nothing), and it must render even when the request file was unreadable —
// in that case the widened fields are absent and choice ids stand in as
// labels. Returns undefined outside a waiting checkpoint.
export function genericCheckpointHtml(ctx: HtmlProjectorContext): string | undefined {
  if (ctx.runOutcome !== 'checkpoint_waiting') return undefined;
  const checkpoint = ctx.checkpoint;
  if (checkpoint === undefined) return undefined;

  // Options come from the request's labeled choices, filtered to the
  // allowed ids the runtime vouched for; any allowed id the request did
  // not cover still gets a row so every legal resume path is visible.
  const allowed = new Set(checkpoint.allowed_choices);
  const labeled = (checkpoint.choices ?? []).filter((choice) => allowed.has(choice.id));
  const covered = new Set(labeled.map((choice) => choice.id));
  const options: CheckpointPageOption[] = [
    ...labeled.map((choice) => ({
      id: choice.id,
      label: choice.label ?? choice.id,
      ...(choice.description === undefined ? {} : { description: choice.description }),
      ...(checkpoint.safe_default_choice === choice.id ? { isDefault: true } : {}),
    })),
    ...checkpoint.allowed_choices
      .filter((id) => !covered.has(id))
      .map((id) => ({
        id,
        label: id,
        ...(checkpoint.safe_default_choice === id ? { isDefault: true } : {}),
      })),
  ];
  if (options.length === 0) return undefined;

  const defaultOption =
    checkpoint.safe_default_choice === undefined
      ? undefined
      : options.find((option) => option.id === checkpoint.safe_default_choice);

  const flowLabel = flowLabelFromId(ctx.flowId);
  const question =
    checkpoint.prompt ??
    `The ${flowLabel} flow is waiting for your choice at ${checkpoint.step_id}.`;
  const ribbon = [
    'Waiting for you',
    ...(checkpoint.depth === undefined ? [] : [`Depth ${checkpoint.depth}`]),
    `${options.length} ${options.length === 1 ? 'choice' : 'choices'}`,
  ];
  const requestPath = checkpoint.request_path.startsWith(`${ctx.runFolder}/`)
    ? checkpoint.request_path.slice(ctx.runFolder.length + 1)
    : checkpoint.request_path;

  return renderCheckpointPage({
    meta: { flowLabel, runId: ctx.runId, stepId: checkpoint.step_id },
    question,
    ribbon,
    options,
    ...(defaultOption === undefined
      ? {}
      : { defaultChoice: { id: defaultOption.id, label: defaultOption.label } }),
    resume: {
      runFolder: ctx.runFolder,
      commandPrefix: ctx.resumeCommandPrefix ?? 'circuit resume',
      attempt: checkpoint.attempt,
      requestSha256: checkpoint.request_sha256,
    },
    footerLeft: `circuit · ${checkpoint.step_id} · ${ctx.runId}`,
    footerRight: requestPath,
  });
}
