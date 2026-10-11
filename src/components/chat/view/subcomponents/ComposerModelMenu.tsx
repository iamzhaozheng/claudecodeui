import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { ProviderModelOption } from '../../../../types/app';
import { Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { DEFAULT_EFFORT_VALUE } from '../../constants/providerEffort';
import { useComposerMenuAnchor } from '../../hooks/useComposerMenuAnchor';

import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from './ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

interface ComposerModelMenuProps {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  onConvertToGpt?: () => void;
  isGptSession?: boolean;
  modelsLoading: boolean;
}

export default function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  onConvertToGpt,
  isGptSession = false,
  modelsLoading,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const [isConversionDialogOpen, setIsConversionDialogOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  // The model list starts collapsed every time the menu opens, the way Codex
  // shows reasoning first and keeps the longer model list one click away.
  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.label || model;

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  const canConvertToGpt = Boolean(onConvertToGpt);
  const continuationLabel = isGptSession
    ? t('composer.newGptContinuation', { defaultValue: 'Continue in a new GPT chat' })
    : t('composer.convertToGpt', { defaultValue: 'Continue with GPT' });
  const continuationTitle = isGptSession
    ? t('composer.newGptContinuationTitle', { defaultValue: 'Continue in a new GPT chat?' })
    : t('composer.convertToGptTitle', { defaultValue: 'Continue with GPT?' });
  if (!hasEffortSection && !hasModelSection && !canConvertToGpt) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-56"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('composer.reasoning', { defaultValue: 'Reasoning' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}
                  description={option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                  className="capitalize"
                />
              ))}
            </>
          )}

          {hasModelSection && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => setIsModelSectionOpen((current) => !current)}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  <ComposerMenuHeading>
                    {t('composer.model', { defaultValue: 'Model' })}
                  </ComposerMenuHeading>
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {modelOptions.map((option) => (
                    <ComposerMenuItem
                      key={option.value}
                      label={option.label || option.value}
                      isSelected={option.value === model}
                      onSelect={() => {
                        onSelectModel(option.value);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                </>
              )}
            </>
          )}

          {canConvertToGpt && (
            <>
              {(hasEffortSection || hasModelSection) && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={continuationLabel}
                description={t('composer.convertToGptHint', {
                  defaultValue: 'Create a GPT chat from this conversation',
                })}
                isSelected={false}
                onSelect={() => {
                  setIsOpen(false);
                  setIsConversionDialogOpen(true);
                }}
              />
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}

      <Dialog open={isConversionDialogOpen} onOpenChange={setIsConversionDialogOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md p-5">
          <DialogTitle>{continuationTitle}</DialogTitle>
          <h2 className="text-lg font-semibold text-foreground">
            {continuationTitle}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t('composer.convertToGptDescription', {
              defaultValue: 'Copy text history to a new GPT chat. The original stays; only attachment names are included.',
            })}
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsConversionDialogOpen(false)}>
              {t('composer.convertToGptCancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button onClick={() => {
              setIsConversionDialogOpen(false);
              onConvertToGpt?.();
            }}>
              {isGptSession
                ? t('composer.newGptContinuationConfirm', { defaultValue: 'Create GPT chat' })
                : t('composer.convertToGptConfirm', { defaultValue: 'Create GPT chat' })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
