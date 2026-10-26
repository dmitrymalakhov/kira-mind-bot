import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { ConfigResponse } from '../types';
import { ConfigSection, type ConfigSectionHandle } from './ConfigSection';
import { LOCAL_MODEL_CONNECTION_SECTION } from '../schema';
import { ImageGenerationSettings } from './ImageGenerationSettings';
import { ModelPreferencesSettings } from './ModelPreferencesSettings';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}
export const ModelSettingsSection = forwardRef<ConfigSectionHandle, Props>(
  function ModelSettingsSection({ config, onUpdate, onToast, onDirtyChange }, ref) {
    const connectionRef = useRef<ConfigSectionHandle>(null);
    useImperativeHandle(ref, () => ({ getUpdates: () => connectionRef.current?.getUpdates() ?? ({}),
      acceptSaved: (saved, submitted) => connectionRef.current?.acceptSaved(saved, submitted) }));
    return <>
      <ModelPreferencesSettings onToast={onToast} localConnection={<ConfigSection inline ref={connectionRef}
        onDirtyChange={onDirtyChange} config={config} onUpdate={onUpdate} onToast={onToast} section={LOCAL_MODEL_CONNECTION_SECTION} />} />
      <ImageGenerationSettings onToast={onToast} />
    </>;
  }
);
