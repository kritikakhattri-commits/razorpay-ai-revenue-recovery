'use client';

import { useState } from 'react';
import type { RecoveryMessageDraft, RecoveryMessageChannel } from '../../src/domain/messaging/types';

interface Props {
  drafts: RecoveryMessageDraft[];
}

const CHANNEL_LABELS: Record<RecoveryMessageChannel, string> = {
  SMS:      'SMS',
  WHATSAPP: 'WhatsApp',
  EMAIL:    'Email',
};

const CHANNEL_ORDER: RecoveryMessageChannel[] = ['SMS', 'WHATSAPP', 'EMAIL'];

export function RecoveryMessagesSection({ drafts }: Props) {
  const [activeChannel, setActiveChannel] = useState<RecoveryMessageChannel>('SMS');
  const [copied, setCopied] = useState(false);

  if (drafts.length === 0) {
    return (
      <div className="mt-8 pt-6 border-t border-neutral-100">
        <h2 className="text-base font-semibold text-neutral-900">Recovery Messages</h2>
        <p className="mt-4 text-sm text-neutral-500">
          No messages available for this recovery case.
        </p>
      </div>
    );
  }

  const activeDraft = drafts.find((d) => d.channel === activeChannel);

  function handleCopy() {
    if (!activeDraft) return;
    const text =
      activeDraft.channel === 'EMAIL' && activeDraft.subject
        ? `Subject: ${activeDraft.subject}\n\n${activeDraft.body}`
        : activeDraft.body;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="mt-8 pt-6 border-t border-neutral-100">
      <h2 className="text-base font-semibold text-neutral-900">Recovery Messages</h2>
      <p className="mt-0.5 text-xs text-neutral-400">
        Draft only — preview before sending through your messaging provider
      </p>

      {/* Channel tabs */}
      <div className="mt-4 flex gap-1">
        {CHANNEL_ORDER.filter((ch) => drafts.some((d) => d.channel === ch)).map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => { setActiveChannel(ch); setCopied(false); }}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors duration-100 ${
              activeChannel === ch
                ? 'bg-neutral-900 text-white'
                : 'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            {CHANNEL_LABELS[ch]}
          </button>
        ))}
      </div>

      {activeDraft && (
        <div className="mt-3 rounded-lg border border-neutral-200 bg-neutral-50 overflow-hidden">
          {/* Email subject */}
          {activeDraft.channel === 'EMAIL' && activeDraft.subject && (
            <div className="px-4 py-2.5 border-b border-neutral-200 bg-white">
              <span className="text-xs text-neutral-400 font-medium">Subject: </span>
              <span className="text-xs text-neutral-700">{activeDraft.subject}</span>
            </div>
          )}

          {/* Message body */}
          <pre className="px-4 py-3 text-xs text-neutral-700 leading-relaxed whitespace-pre-wrap font-sans">
            {activeDraft.body}
          </pre>

          {/* Footer */}
          <div className="px-4 py-2.5 border-t border-neutral-200 bg-white flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-xs text-neutral-400">
              <span>
                Tone:{' '}
                <span className="font-medium text-neutral-600">{activeDraft.tone}</span>
              </span>
              {activeDraft.requiresPaymentLink && (
                <span className="inline-flex items-center gap-1 text-amber-600">
                  Requires payment link
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors duration-100"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
