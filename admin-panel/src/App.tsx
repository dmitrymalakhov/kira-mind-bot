import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack } from '@mui/material';
import { LoginPage } from './pages/LoginPage';
import { Dashboard, type Page, type SettingsTab } from './components/Dashboard';
import { BrandMark } from './components/BrandMark';
import { AUTH_REQUIRED_EVENT, AdminApiError, fetchConfig, fetchManagedAccounts, setAdminAccount, logout, type ManagedAccountsResponse } from './api';
import { clearAccountDrafts } from './accountEdits';
import type { ConfigResponse } from './types';

const STORAGE_KEY='kira.admin.account.v1';
export default function App() {
  const [auth,setAuth]=useState<'loading'|'unauthenticated'|'authenticated'>('loading');
  const [config,setConfig]=useState<ConfigResponse>({});
  const [accounts,setAccounts]=useState<ManagedAccountsResponse>();
  const [selected,setSelected]=useState<string>();
  const [page,setPage]=useState<Page>('settings'),[settingsTab,setSettingsTab]=useState<SettingsTab>('model');
  const [scopeLoading,setScopeLoading]=useState(false),[scopeError,setScopeError]=useState(''),[bootError,setBootError]=useState('');
  const active=useRef<string>(),boot=useRef(0),configRequest=useRef(0);
  const reset=useCallback(()=>{
    boot.current++;configRequest.current++;active.current=undefined;setAdminAccount(undefined,true);clearAccountDrafts();
    setConfig({});setAccounts(undefined);setSelected(undefined);setScopeError('');setScopeLoading(false);setAuth('unauthenticated');
  },[]);
  const loadConfig=useCallback(async(id:string|undefined)=>{
    const request=++configRequest.current;setScopeLoading(true);setScopeError('');setConfig({});
    try { const next=await fetchConfig();if(active.current===id&&request===configRequest.current)setConfig(next); }
    catch(error){if(active.current===id&&request===configRequest.current){if(error instanceof AdminApiError&&error.status===401)reset();else setScopeError(error instanceof Error?error.message:'Не удалось загрузить выбранную Киру.');}}
    finally{if(active.current===id&&request===configRequest.current)setScopeLoading(false);}
  },[reset]);
  const select=useCallback(async(id:string|undefined)=>{
    try { setAdminAccount(id); }catch(error){setScopeError((error as Error).message);return;}
    active.current=id;setSelected(id);clearAccountDrafts();
    try{if(id)sessionStorage.setItem(STORAGE_KEY,id);else sessionStorage.removeItem(STORAGE_KEY);}catch{/* Optional preference. */}
    await loadConfig(id);
  },[loadConfig]);
  const bootstrap=useCallback(async()=>{
    const generation=++boot.current;setBootError('');setAuth('loading');
    try{
      const list=await fetchManagedAccounts();if(generation!==boot.current)return;
      setAccounts(list);
      if(list.available && !list.accounts.length)setPage('accounts');
      let id:string|undefined;
      if(list.available){let remembered:string|null=null;try{remembered=sessionStorage.getItem(STORAGE_KEY);}catch{/* Optional preference. */}
        id=remembered==='instance'?'instance':list.accounts.find(a=>a.id===remembered)?.id
          || list.accounts.find(a=>a.bot?.connected||a.runtimeMode==='api_only'&&a.accountState==='active')?.id || list.accounts[0]?.id || 'instance';}
      setAdminAccount(id,true);active.current=id;setSelected(id);setAuth('authenticated');
      await loadConfig(id);
    }catch(error){if(generation!==boot.current)return;if(error instanceof AdminApiError&&error.status===401)reset();else{setBootError(error instanceof Error?error.message:'Сервис аккаунтов недоступен.');setAuth('loading');}}
  },[loadConfig,reset]);
  useEffect(()=>{
    window.addEventListener(AUTH_REQUIRED_EVENT,reset);void bootstrap();
    return()=>{window.removeEventListener(AUTH_REQUIRED_EVENT,reset);boot.current++;};
  },[bootstrap,reset]);
  const changed=useCallback((list:ManagedAccountsResponse)=>{
    setAccounts(list);
    if(list.available&&active.current&&active.current!=='instance'&&!list.accounts.some(a=>a.id===active.current)){
      setConfig({});setScopeError('Выбранный аккаунт больше недоступен. Выберите другую Киру.');
    }
  },[]);
  if(auth==='loading')return <Stack spacing={3} alignItems="center" justifyContent="center" sx={{minHeight:'100vh',p:3}}>
    <BrandMark size={96}/>{bootError?<><Alert severity="error">{bootError}</Alert><Button onClick={()=>void bootstrap()}>Повторить загрузку</Button><Button onClick={()=>void logout().then(reset)}>Выйти</Button></>:<CircularProgress size={24} aria-label="Загрузка Kira Mind"/>}
  </Stack>;
  if(auth==='unauthenticated')return <LoginPage onLogin={()=>void bootstrap()}/>;
  return <Box><Dashboard key={selected||'legacy'} config={config} onLogout={reset}
    onConfigUpdate={next=>{if(active.current===selected)setConfig(next);}}
    accounts={accounts} selectedAccount={selected} onAccountSelect={id=>void select(id)} onAccountsChanged={changed}
    initialPage={page} onPageChange={setPage} initialSettingsTab={settingsTab} onSettingsTabChange={setSettingsTab}
    scopeLoading={scopeLoading} scopeError={scopeError} onScopeRetry={()=>void loadConfig(selected)}/></Box>;
}
