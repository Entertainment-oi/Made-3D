import { dom, setStatus } from './dom.js';
import { closeAllPopovers } from './ui/popovers.js';

function detectStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator?.standalone === true
  );
}

function detectIOS() {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator?.userAgent || '';
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (window.navigator?.platform === 'MacIntel' && window.navigator?.maxTouchPoints > 1)
  );
}

export function initPWA() {
  if (typeof window === 'undefined') return;

  let deferredPrompt = null;
  let isInstalled = detectStandalone();
  const isIOS = detectIOS();

  const syncOfflineBanner = () => {
    if (!dom.pwaOfflineBanner) return;
    dom.pwaOfflineBanner.hidden = navigator.onLine !== false;
  };

  const openInstallGuideModal = (mode = 'ios') => {
    if (!dom.pwaInstallModal) return;
    closeAllPopovers();
    if (dom.pwaInstallModalTitle) {
      dom.pwaInstallModalTitle.textContent =
        mode === 'ios' ? 'Instalar en iPhone / iPad' : 'Instalar Made3D Studio';
    }
    if (dom.pwaInstallGuideIos) dom.pwaInstallGuideIos.hidden = mode !== 'ios';
    if (dom.pwaInstallGuideBrowser) dom.pwaInstallGuideBrowser.hidden = mode === 'ios';
    dom.pwaInstallModal.hidden = false;
  };

  const closeInstallGuideModal = () => {
    if (dom.pwaInstallModal) dom.pwaInstallModal.hidden = true;
  };

  const syncInstallUI = () => {
    const canPrompt = Boolean(deferredPrompt);
    const showTopBtn = !isInstalled && (canPrompt || isIOS);
    if (dom.btnInstallPwa) {
      dom.btnInstallPwa.hidden = !showTopBtn;
      if (dom.btnInstallPwaLabel) {
        dom.btnInstallPwaLabel.textContent = isIOS && !canPrompt ? 'Instalar iOS' : 'Instalar app';
      }
    }
    if (dom.btnSettingsInstallPwa) {
      dom.btnSettingsInstallPwa.hidden = isInstalled;
      if (dom.settingsInstallPwaState) {
        dom.settingsInstallPwaState.textContent = canPrompt
          ? 'Disponible'
          : isIOS
          ? 'Safari iOS'
          : 'PWA';
      }
    }
  };

  const triggerInstall = async () => {
    closeAllPopovers();
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice?.outcome === 'accepted') {
          isInstalled = true;
          deferredPrompt = null;
          setStatus('Made3D Studio instalada correctamente.');
        }
      } catch {
        openInstallGuideModal(isIOS ? 'ios' : 'browser');
      }
      syncInstallUI();
      return;
    }
    openInstallGuideModal(isIOS ? 'ios' : 'browser');
  };

  dom.btnInstallPwa?.addEventListener('click', triggerInstall);
  dom.btnSettingsInstallPwa?.addEventListener('click', triggerInstall);
  dom.btnPwaInstallX?.addEventListener('click', closeInstallGuideModal);
  dom.btnPwaInstallClose?.addEventListener('click', closeInstallGuideModal);
  dom.pwaInstallModal?.addEventListener('click', (e) => {
    if (e.target === dom.pwaInstallModal) closeInstallGuideModal();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    syncInstallUI();
  });

  window.addEventListener('appinstalled', () => {
    isInstalled = true;
    deferredPrompt = null;
    closeInstallGuideModal();
    syncInstallUI();
    setStatus('Made3D Studio instalada como aplicación.');
  });

  const displayMq = window.matchMedia?.('(display-mode: standalone)');
  displayMq?.addEventListener?.('change', (e) => {
    isInstalled = e.matches || window.navigator?.standalone === true;
    syncInstallUI();
  });

  window.addEventListener('online', () => {
    syncOfflineBanner();
    setStatus('Conexión restablecida.');
  });
  window.addEventListener('offline', syncOfflineBanner);

  syncInstallUI();
  syncOfflineBanner();

  if ('serviceWorker' in navigator) {
    import('virtual:pwa-register')
      .then(({ registerSW }) => {
        registerSW({
          immediate: true,
          onOfflineReady() {
            setStatus('App lista para usarse sin conexión.');
          },
        });
      })
      .catch(() => {
        // Ignore if running outside Vite dev/build environment
      });
  }
}
