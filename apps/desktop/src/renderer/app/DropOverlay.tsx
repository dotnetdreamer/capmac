import { useEffect, useState } from 'react';
import { openProject } from '../state/actions';
import { Icon } from '../ui/Icon';

/** Drop a Capacitor app folder anywhere on the window to open it. */
export function DropOverlay() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'link';
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const path = window.capmac.pathForFile(file);
      if (path) void openProject(path);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!over) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay__card">
        <Icon name="folderAdd" size={28} />
        <div className="drop-overlay__title">Drop to open your Capacitor app</div>
        <div className="drop-overlay__text">The folder with capacitor.config.* (or any folder inside it)</div>
      </div>
    </div>
  );
}
