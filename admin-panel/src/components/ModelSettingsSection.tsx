import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import type { ConfigResponse } from '../types';
import { ConfigSection, type ConfigSectionHandle } from './ConfigSection';
import { LOCAL_MODEL_CONNECTION_SECTION, VOICE_MODEL_SECTION, IMAGE_CONNECTION_SECTION } from '../schema';
import { ImageGenerationSettings } from './ImageGenerationSettings';
import { ModelPreferencesSettings } from './ModelPreferencesSettings';
import { SettingsTile } from './SettingsTile';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}
export const ModelSettingsSection = forwardRef<ConfigSectionHandle, Props>(
  function ModelSettingsSection({ config, onUpdate, onToast, onDirtyChange }, ref) {
    const connectionRef = useRef<ConfigSectionHandle>(null);
    const voiceRef = useRef<ConfigSectionHandle>(null);
    const imageRef = useRef<ConfigSectionHandle>(null);
    const [voiceOpen, setVoiceOpen] = useState(false);
    useImperativeHandle(ref, () => ({
      getUpdates: () => Object.assign({}, ...[connectionRef, voiceRef, imageRef].map(item => item.current?.getUpdates() ?? {})),
      acceptSaved: (saved, submitted) => [connectionRef, voiceRef, imageRef].forEach(item => item.current?.acceptSaved(saved, submitted)),
    }));
    const editor = (section: typeof VOICE_MODEL_SECTION, editorRef: typeof voiceRef) => <ConfigSection inline ref={editorRef}
      saveLabel={section.id === 'voice-model' ? 'Сохранить голос' : 'Сохранить подключение'}
      onDirtyChange={onDirtyChange} config={config} onUpdate={onUpdate} onToast={onToast} section={section} />;
    return <>
      <ModelPreferencesSettings onToast={onToast} localConnection={editor(LOCAL_MODEL_CONNECTION_SECTION, connectionRef)} />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2.5, mt: 2.5 }}>
        <ImageGenerationSettings compact onToast={onToast} connectionEditor={editor(IMAGE_CONNECTION_SECTION, imageRef)} />
        <SettingsTile title="Голос" description="Озвучивание ответов, тембр и модель речи." icon={<MicNoneOutlinedIcon />} tint="#EEE7F1"
          value={config.ELEVENLABS_MODEL_ID?.value || 'Выберите голос и модель'} onClick={() => setVoiceOpen(true)} />
      </Box>
      <Dialog open={voiceOpen} keepMounted fullWidth maxWidth="md" onClose={() => setVoiceOpen(false)} aria-labelledby="voice-dialog-title">
        <DialogTitle id="voice-dialog-title">Голос Киры</DialogTitle>
        <DialogContent dividers>{editor(VOICE_MODEL_SECTION, voiceRef)}</DialogContent>
        <DialogActions><Button onClick={() => setVoiceOpen(false)}>Закрыть</Button></DialogActions>
      </Dialog>
    </>;
  }
);
