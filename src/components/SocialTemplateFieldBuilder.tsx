'use client'

import { useConfig, useField } from '@payloadcms/ui'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import type { SocialCopyFieldKey } from '../types/index.js'

import {
  applyFilter,
  compilePreviewRequestBody,
  FILTER_TAKES_ARG,
  INSERTABLE_STATIC_TOKENS,
  sampleListUrl,
  TEMPLATE_FILTERS,
  tokensFromScopeKeys,
} from './socialTemplateBuilderModel.js'
import './SocialPublishPanelClient.scss'

// ---------------------------------------------------------------------------
// Platform character limits used for the per-field length warning
// ---------------------------------------------------------------------------

const FIELD_LIMITS: Partial<Record<SocialCopyFieldKey, number>> = {
  gbpSummary: 1500,
  instagramCaption: 2200,
  pinterestAltText: 500,
  pinterestDescription: 500,
  pinterestTitle: 100,
  // facebookMessage and pinterestHashtags have no hard platform cap in the plugin
}

const COPY_FIELD_LABELS: Record<SocialCopyFieldKey, string> = {
  facebookMessage: 'Facebook message',
  gbpSummary: 'Google Business Profile summary',
  instagramCaption: 'Instagram caption',
  pinterestAltText: 'Pinterest alt text',
  pinterestDescription: 'Pinterest description',
  pinterestHashtags: 'Pinterest hashtags',
  pinterestTitle: 'Pinterest title',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SourceKindEntry = {
  collection: string
  kind: string
  label: string
}

type AsRecord = (v: unknown) => Record<string, unknown> | undefined
const asRecord: AsRecord = (v) =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type TokenPickerProps = {
  kindLabel?: string
  metaTokens: string[]
  onInsert: (token: string) => void
  staticTokens: string[]
  /**
   * `discovered` — tokens came from the bound kind's sample record (its real
   * fields). `fallback` — no sample record, so the full static list is shown.
   * `none` — no source kind is bound yet.
   */
  variant: 'discovered' | 'fallback' | 'none'
}

const TokenPicker: React.FC<TokenPickerProps> = ({
  kindLabel,
  metaTokens,
  onInsert,
  staticTokens,
  variant,
}) => {
  const label =
    variant === 'none'
      ? 'Insert:'
      : `Insert${kindLabel ? ` (fields available for ${kindLabel})` : ''}:`

  return (
    <div aria-label="Insert token" className="stfb__token-picker" role="group">
      <span className="stfb__token-picker-label">{label}</span>
      {staticTokens.map((token) => (
        <button
          aria-label={`Insert ${token} token`}
          className="stfb__token-chip"
          key={token}
          onClick={() => onInsert(token)}
          type="button"
        >
          {token}
        </button>
      ))}
      {metaTokens.length > 0 && (
        <>
          <span aria-hidden="true" className="stfb__token-picker-sep">
            |
          </span>
          {metaTokens.map((token) => (
            <button
              aria-label={`Insert ${token} token`}
              className="stfb__token-chip stfb__token-chip--meta"
              key={token}
              onClick={() => onInsert(token)}
              type="button"
            >
              {token}
            </button>
          ))}
        </>
      )}
      {variant === 'none' && (
        <span className="stfb__token-hint">
          Choose the collection this template is for (the “Source kind” field) to see its fields.
        </span>
      )}
      {variant === 'fallback' && (
        <span className="stfb__token-hint">
          Showing all template fields; this collection has no sample record to discover its fields
          from yet.
        </span>
      )}
    </div>
  )
}

type FilterMenuProps = {
  onApply: (filter: string, arg?: string) => void
  token: string
}

const FilterMenu: React.FC<FilterMenuProps> = ({ onApply, token }) => {
  const [filter, setFilter] = useState<string>(TEMPLATE_FILTERS[0])
  const [arg, setArg] = useState('')

  const needsArg = FILTER_TAKES_ARG[filter as keyof typeof FILTER_TAKES_ARG] ?? false

  if (!token) {
    return null
  }

  return (
    <div aria-label="Apply filter" className="stfb__filter-menu" role="group">
      <span className="stfb__filter-label">Filter:</span>
      <select
        aria-label="Select filter"
        className="stfb__filter-select"
        onChange={(e) => {
          setFilter(e.target.value)
          setArg('')
        }}
        value={filter}
      >
        {TEMPLATE_FILTERS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      {needsArg && (
        <input
          aria-label={`${filter} argument`}
          className="stfb__filter-arg"
          onChange={(e) => setArg(e.target.value)}
          placeholder={filter === 'truncate' ? 'N chars' : 'value'}
          value={arg}
        />
      )}
      <button
        aria-label={`Apply ${filter} filter`}
        className="stfb__filter-apply"
        onClick={() => onApply(filter, needsArg ? arg : undefined)}
        type="button"
      >
        Apply to {token}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type SocialTemplateFieldBuilderProps = {
  /** The copy field key this builder is mounted for. */
  copyField: SocialCopyFieldKey
  /** Whether the underlying storage field is multiline (textarea vs input). */
  multiline?: boolean
  path: string
}

export const SocialTemplateFieldBuilder: React.FC<SocialTemplateFieldBuilderProps> = ({
  copyField,
  multiline = false,
  path,
}) => {
  const { setValue, value } = useField<string>({ path })
  // The builder is locked to the collection the template row declares. Read the
  // document's own `sourceKind` field live so the sample-record picker, token
  // discovery, and live preview all target that collection's resolver.
  const { value: docSourceKind } = useField<string>({ path: 'sourceKind' })
  const { config } = useConfig()

  // ---------- config.admin?.custom.socials ------------------------------------
  //
  // Fix 1: read from config.admin?.custom (serialized to browser by Payload)
  // instead of config.custom (stripped by Payload 3.86 serverOnlyConfigProperties).

  const socials = asRecord(asRecord(config.admin?.custom)?.socials)
  const sourceKinds: SourceKindEntry[] = Array.isArray(socials?.sourceKinds)
    ? (socials.sourceKinds as unknown[]).flatMap((entry) => {
        const rec = asRecord(entry)
        if (!rec || typeof rec.kind !== 'string' || typeof rec.collection !== 'string') {
          return []
        }
        return [
          {
            collection: rec.collection,
            kind: rec.kind,
            label: typeof rec.label === 'string' ? rec.label : rec.collection,
          },
        ]
      })
    : []

  const apiRoute =
    typeof config.routes?.api === 'string' ? config.routes.api.replace(/\/$/, '') : '/api'
  const basePath = typeof socials?.apiBasePath === 'string' ? socials.apiBasePath : '/socials'
  const previewUrl = `${apiRoute}${basePath}/templates/preview`

  // ---------- UI state -------------------------------------------------------

  const [rawMode, setRawMode] = useState(false)
  // The template's bound source kind drives the preview. Empty until the
  // operator picks a collection on the row.
  const selectedKind = typeof docSourceKind === 'string' ? docSourceKind : ''
  const boundKind = sourceKinds.find((sk) => sk.kind === selectedKind)
  const [selectedId, setSelectedId] = useState('')
  const [previewText, setPreviewText] = useState<string>()
  const [previewError, setPreviewError] = useState<string>()
  // The bound kind's real, populated tokens as reported by the preview endpoint
  // for the auto-resolved sample record (static aliases + discovered metadata.*).
  const [discoveredScopeKeys, setDiscoveredScopeKeys] = useState<string[]>([])
  const [activeToken, setActiveToken] = useState('')
  const textRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  const currentValue = typeof value === 'string' ? value : ''
  const charLimit = FIELD_LIMITS[copyField]

  // ---------- Cursor tracking ------------------------------------------------

  const cursorRef = useRef<number>(0)
  const trackCursor = (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const el = e.currentTarget
    cursorRef.current = el.selectionStart ?? currentValue.length
  }

  // ---------- Live preview (debounced) ---------------------------------------

  const debounceRef = useRef<null | ReturnType<typeof setTimeout>>(null)
  const abortRef = useRef<AbortController | null>(null)

  const runPreview = useCallback(
    (kind: string, id: string, fields: Record<string, string>) => {
      if (!kind || !id) {
        setPreviewText(undefined)
        return
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      debounceRef.current = setTimeout(() => {
        abortRef.current?.abort()
        const ctrl = new AbortController()
        abortRef.current = ctrl
        void fetch(previewUrl, {
          body: JSON.stringify(compilePreviewRequestBody(kind, id, fields)),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          signal: ctrl.signal,
        })
          .then(async (res) => {
            const body = (await res.json()) as {
              error?: string
              resolved?: Record<string, string>
              scopeKeys?: string[]
            }
            if (!res.ok) {
              setPreviewError(body.error ?? 'Preview failed')
              setPreviewText(undefined)
              return
            }
            setPreviewError(undefined)
            setPreviewText(body.resolved?.[copyField] ?? '')
            setDiscoveredScopeKeys(body.scopeKeys ?? [])
          })
          .catch((err: unknown) => {
            if (err instanceof Error && err.name === 'AbortError') {
              return
            }
            setPreviewError('Preview request failed')
          })
      }, 350)
    },
    [copyField, previewUrl],
  )

  useEffect(() => {
    runPreview(selectedKind, selectedId, { [copyField]: currentValue })
  }, [copyField, currentValue, runPreview, selectedId, selectedKind])

  // ---------- Auto-resolve a sample record for the bound kind -----------------
  //
  // On mount (when a kind is already set) and whenever the bound kind changes,
  // fetch the most recent record of that kind's collection and pre-select it, so
  // the token picker and live preview show that collection's real fields without
  // the operator hand-picking a record first. Manual record-ID edits are
  // preserved (this effect does not depend on selectedId).
  const boundCollection = boundKind?.collection
  const sampleAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!boundCollection) {
      return
    }
    sampleAbortRef.current?.abort()
    const ctrl = new AbortController()
    sampleAbortRef.current = ctrl
    // Clear stale tokens from a previous kind until the new sample resolves.
    setDiscoveredScopeKeys([])
    void fetch(sampleListUrl(apiRoute, boundCollection), { signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json()) as { docs?: Array<{ id?: number | string }> }
        if (!res.ok) {
          return
        }
        const firstId = Array.isArray(body.docs) ? body.docs[0]?.id : undefined
        if (typeof firstId === 'string' || typeof firstId === 'number') {
          setSelectedId(String(firstId))
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          return
        }
        // A failed sample fetch is non-fatal; the picker falls back to the full
        // static token list so the builder is never empty.
      })
    return () => ctrl.abort()
  }, [apiRoute, boundCollection])

  // ---------- Handlers -------------------------------------------------------

  const handleInsertToken = (token: string) => {
    const newValue = `${currentValue.slice(0, cursorRef.current)}{{ ${token} }}${currentValue.slice(cursorRef.current)}`
    setValue(newValue)
    setActiveToken(token)
    // Restore focus after React re-render
    setTimeout(() => textRef.current?.focus(), 0)
  }

  const handleApplyFilter = (filter: string, arg?: string) => {
    if (!activeToken) {
      return
    }
    setValue(applyFilter(currentValue, activeToken, filter, arg))
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValue(e.target.value)
  }

  // ---------- Token picker source --------------------------------------------
  //
  // Drive the picker from the bound kind's discovered scope keys (its real
  // fields) when available. With a kind but no discovered keys yet (no records,
  // or the sample/preview fetch failed), fall back to the full static list so
  // the builder is never empty. With no kind bound, show only the minimal
  // always-present aliases plus a hint.
  const { metadata: discoveredMeta, static: discoveredStatic } =
    tokensFromScopeKeys(discoveredScopeKeys)
  const hasDiscovered = discoveredScopeKeys.length > 0
  const tokenVariant: 'discovered' | 'fallback' | 'none' = !selectedKind
    ? 'none'
    : hasDiscovered
      ? 'discovered'
      : 'fallback'
  const pickerStatic = !selectedKind
    ? ['title', 'description']
    : hasDiscovered
      ? discoveredStatic
      : [...INSERTABLE_STATIC_TOKENS]
  const pickerMeta = tokenVariant === 'discovered' ? discoveredMeta : []

  // ---------- Render ---------------------------------------------------------

  const overLimit = charLimit !== undefined && currentValue.length > charLimit

  return (
    <div className="stfb">
      {/* Field label + raw-mode toggle */}
      <div className="stfb__toolbar">
        <span className="stfb__field-label">{COPY_FIELD_LABELS[copyField]}</span>
        <button
          aria-pressed={rawMode}
          className={`stfb__raw-toggle${rawMode ? ' stfb__raw-toggle--active' : ''}`}
          onClick={() => setRawMode((prev) => !prev)}
          type="button"
        >
          {rawMode ? 'Builder mode' : 'Raw mode'}
        </button>
      </div>

      {rawMode ? (
        /* Raw-string fallback: plain textarea or input */
        multiline ? (
          <textarea
            aria-label={`${copyField} template (raw)`}
            className="stfb__raw-area"
            onChange={handleChange}
            onKeyUp={trackCursor}
            onSelect={trackCursor}
            ref={textRef as React.Ref<HTMLTextAreaElement>}
            rows={4}
            value={currentValue}
          />
        ) : (
          <input
            aria-label={`${copyField} template (raw)`}
            className="stfb__raw-input"
            onChange={handleChange}
            onKeyUp={trackCursor}
            onSelect={trackCursor}
            ref={textRef as React.Ref<HTMLInputElement>}
            type="text"
            value={currentValue}
          />
        )
      ) : (
        /* Builder: editable field + pickers */
        <div className="stfb__builder">
          {multiline ? (
            <textarea
              aria-label={`${copyField} template`}
              className="stfb__field"
              onChange={handleChange}
              onKeyUp={trackCursor}
              onSelect={trackCursor}
              ref={textRef as React.Ref<HTMLTextAreaElement>}
              rows={4}
              value={currentValue}
            />
          ) : (
            <input
              aria-label={`${copyField} template`}
              className="stfb__field"
              onChange={handleChange}
              onKeyUp={trackCursor}
              onSelect={trackCursor}
              ref={textRef as React.Ref<HTMLInputElement>}
              type="text"
              value={currentValue}
            />
          )}

          <TokenPicker
            kindLabel={boundKind?.label ?? selectedKind}
            metaTokens={pickerMeta}
            onInsert={handleInsertToken}
            staticTokens={pickerStatic}
            variant={tokenVariant}
          />

          <FilterMenu onApply={handleApplyFilter} token={activeToken} />

          <p className="stfb__scope-hint">
            Only tokens in scope (resolved by the host&apos;s SourceContextResolver) produce output.
            Fields not in scope must be exposed via the resolver&apos;s <code>metadata</code> map.
          </p>
        </div>
      )}

      {/* Character count */}
      <div className="stfb__meta">
        <span
          aria-live="polite"
          className={overLimit ? 'stfb__char-count stfb__char-count--over' : 'stfb__char-count'}
        >
          {currentValue.length}
          {charLimit !== undefined ? ` / ${charLimit}` : ''} chars
        </span>
      </div>

      {/* Live preview — locked to the template's bound source kind */}
      {sourceKinds.length > 0 && (
        <details className="stfb__preview-section">
          <summary className="stfb__preview-summary">Live preview</summary>
          {selectedKind ? (
            <>
              <div className="stfb__preview-controls">
                <span className="stfb__preview-label-text">
                  Previewing a <strong>{boundKind?.label ?? selectedKind}</strong> record. A recent
                  one is auto-selected; change the ID to preview a different record.
                </span>
                <label className="stfb__preview-label">
                  Record ID
                  <input
                    aria-label="Preview record ID"
                    className="stfb__preview-id"
                    onChange={(e) => setSelectedId(e.target.value)}
                    placeholder="Auto-filled from a recent record"
                    type="text"
                    value={selectedId}
                  />
                </label>
              </div>

              {previewError && (
                <p className="stfb__preview-error" role="alert">
                  {previewError}
                </p>
              )}
              {previewText !== undefined && !previewError && (
                <div aria-live="polite" className="stfb__preview-output">
                  <span className="stfb__preview-label-text">Rendered output:</span>
                  <pre className="stfb__preview-text">{previewText || '(empty)'}</pre>
                </div>
              )}
            </>
          ) : (
            <p className="stfb__preview-hint">
              Choose the collection this template is for (the “Source kind” field above) to preview
              it against a record.
            </p>
          )}
        </details>
      )}
    </div>
  )
}
