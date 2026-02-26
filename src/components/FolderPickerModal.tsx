import { useState, useEffect } from "react";
import { Folder, ArrowUpToLine, X, Loader2, FolderOpen } from "lucide-react";
import toast from "react-hot-toast";

interface FolderPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export function FolderPickerModal({ isOpen, onClose, onSelect }: FolderPickerModalProps) {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadDirectory(""); // load default/home dir
    }
  }, [isOpen]);

  const loadDirectory = async (targetPath: string) => {
    setIsLoading(true);
    try {
      const url = targetPath ? `/api/directories?path=${encodeURIComponent(targetPath)}` : `/api/directories`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (res.ok) {
        setCurrentPath(data.currentPath);
        setParentPath(data.parentPath);
        setFolders(data.folders || []);
        if (data.error) toast.error(data.error);
      } else {
        toast.error(data.error || "Failed to load directory");
      }
    } catch {
      toast.error("Network error while loading directory");
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[80vh] animate-in zoom-in-95">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div>
            <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <FolderOpen className="w-5 h-5 text-purple-400" />
              Select Folder
            </h3>
            <div className="text-xs text-zinc-400 mt-1 font-mono truncate max-w-[300px]" title={currentPath}>
              {currentPath}
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Browser */}
        <div className="flex-1 overflow-y-auto p-2 min-h-[300px]">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
            </div>
          ) : (
            <ul className="space-y-1">
              {parentPath !== undefined && parentPath !== null && (
                <li>
                  <button 
                    onClick={() => loadDirectory(parentPath)}
                    className="w-full text-left px-3 py-2 flex items-center gap-3 text-sm text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
                  >
                    <ArrowUpToLine className="w-4 h-4 text-zinc-500" />
                    <span className="font-medium text-zinc-400">.. (Go up)</span>
                  </button>
                </li>
              )}
              {folders.map(folder => {
                // Determine path separator based on whether currentPath looks like Windows
                const separator = currentPath === 'root' ? '' : (currentPath.includes('\\') ? '\\' : '/');
                const nextPath = currentPath === 'root' ? folder : `${currentPath.replace(/[\\/]$/, '')}${separator}${folder}`;
                return (
                  <li key={folder}>
                    <button 
                      onClick={() => loadDirectory(nextPath)}
                      className="w-full text-left px-3 py-2 flex items-center gap-3 text-sm text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
                    >
                      <Folder className="w-4 h-4 text-zinc-500 shrink-0 fill-zinc-800/50" />
                      <span className="truncate">{folder}</span>
                    </button>
                  </li>
                );
              })}
              {folders.length === 0 && (
                <div className="text-center text-zinc-500 py-10 text-sm">
                  This folder is empty
                </div>
              )}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-800 flex justify-end gap-3 bg-zinc-900/50 rounded-b-xl">
          <button 
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={() => {
              if (currentPath !== 'root') {
                onSelect(currentPath);
                onClose();
              } else {
                toast.error("Select a drive first");
              }
            }}
            disabled={currentPath === 'root' || isLoading}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Select Current Folder
          </button>
        </div>

      </div>
    </div>
  );
}
