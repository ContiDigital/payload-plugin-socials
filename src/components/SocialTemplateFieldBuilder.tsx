'use client'

import { useConfig, useField } from '@payloadcms/ui'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import type { SocialCopyFieldKey } from '../types/index.js'

import {
  applyFilter,
  compilePreviewRequestBody,
  FILTER_TAKES_ARG,
  INSERTABLE_STATIC_TOKENS,
  isMetadataToken,
  TEMPLATE_FILTERS,
} from './socialTemplateBuilderModel.js'

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
  discoveredMetaKeys: string[]
  onInsert: (token: string) => void
}

const TokenPicker: React.FC<TokenPickerProps> = ({ discoveredMetaKeys, onInsert }) => {
  const staticTokens = [...INSERTABLE_STATIC_TOKENS]
  const metaTokens = discoveredMetaKeys.filter(isMetadataToken)

  return (
    <div aria-label="Insert token" className="stfb__token-picker" role="group">
      <span className="stfb__token-picker-label">Insert:</span>
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
      {discoveredMetaKeys.length === 0 && (
        <span className="stfb__token-hint">
          metadata.* tokens appear after selecting a record below.
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
  const { config } = useConfig()

  // ---------- config.custom.socials -----------------------------------------

  const socials = asRecord(asRecord(config.custom)?.socials)
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
  const [selectedKind, setSelectedKind] = useState(sourceKinds[0]?.kind ?? '')
  const [selectedId, setSelectedId] = useState('')
  const [previewText, setPreviewText] = useState<string>()
  const [previewError, setPreviewError] = useState<string>()
  const [discoveredMetaKeys, setDiscoveredMetaKeys] = useState<string[]>([])
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
            const newMeta = (body.scopeKeys ?? []).filter(isMetadataToken)
            setDiscoveredMetaKeys(newMeta)
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

  // ---------- Render ---------------------------------------------------------

  const overLimit = charLimit !== undefined && currentValue.length > charLimit

  return (
    <div className="stfb">
      {/* Raw-mode toggle */}
      <div className="stfb__toolbar">
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

          <TokenPicker discoveredMetaKeys={discoveredMetaKeys} onInsert={handleInsertToken} />

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

      {/* Live preview */}
      {sourceKinds.length > 0 && (
        <details className="stfb__preview-section">
          <summary className="stfb__preview-summary">Live preview</summary>
          <div className="stfb__preview-controls">
            {sourceKinds.length > 1 && (
              <label className="stfb__preview-label">
                Source kind
                <select
                  aria-label="Preview source kind"
                  className="stfb__preview-select"
                  onChange={(e) => setSelectedKind(e.target.value)}
                  value={selectedKind}
                >
                  {sourceKinds.map((sk) => (
                    <option key={sk.kind} value={sk.kind}>
                      {sk.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="stfb__preview-label">
              Record ID
              <input
                aria-label="Preview record ID"
                className="stfb__preview-id"
                onChange={(e) => setSelectedId(e.target.value)}
                placeholder="Enter a record ID to preview"
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
        </details>
      )}
    </div>
  )
}
