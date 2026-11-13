"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Home,
} from "lucide-react";
import type { FolderItem } from "@streamora/contracts";

export interface FolderTreeNode extends FolderItem {
  children: FolderTreeNode[];
  depth: number;
}

export function buildFolderTree(
  folders: FolderItem[],
  parentId: string | null = null,
  depth = 0,
): FolderTreeNode[] {
  return folders
    .filter((f) => (f.parentId ?? null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "vi"))
    .map((f) => ({
      ...f,
      depth,
      children: buildFolderTree(folders, f.id, depth + 1),
    }));
}

/**
 * Tìm tất cả ID tổ tiên của một folderId trong danh sách folder
 */
export function getAncestorFolderIds(
  folders: FolderItem[],
  targetId: string | null,
): Set<string> {
  const ancestors = new Set<string>();
  if (!targetId) return ancestors;

  const folderMap = new Map<string, FolderItem>();
  for (const f of folders) {
    folderMap.set(f.id, f);
  }

  let curr = folderMap.get(targetId);
  while (curr && curr.parentId) {
    ancestors.add(curr.parentId);
    curr = folderMap.get(curr.parentId);
  }
  return ancestors;
}

interface FolderTreeProps {
  folders: FolderItem[];
  selectedId: string | null;
  onSelect: (folderId: string | null) => void;
  includeRoot?: boolean;
  rootLabel?: string;
  disabledId?: string | null;
  className?: string;
  autoExpandSelected?: boolean;
}

export function FolderTree({
  folders,
  selectedId,
  onSelect,
  includeRoot = true,
  rootLabel = "Tài liệu chung",
  disabledId,
  className = "",
  autoExpandSelected = true,
}: FolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(folders, null, 0), [folders]);

  // Quản lý các node đang mở
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    // Khởi tạo: Mở các tổ tiên của selectedId và các folder gốc
    const initial = new Set<string>();
    // Mở các thư mục gốc có con để người dùng thấy ngay cấu trúc
    for (const f of folders) {
      if (!f.parentId && (f.folderCount ?? 0) > 0) {
        initial.add(f.id);
      }
    }
    if (selectedId) {
      const ancestors = getAncestorFolderIds(folders, selectedId);
      ancestors.forEach((id) => initial.add(id));
      initial.add(selectedId);
    }
    return initial;
  });

  // Tự động mở rộng khi selectedId thay đổi
  useEffect(() => {
    if (autoExpandSelected && selectedId) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        const ancestors = getAncestorFolderIds(folders, selectedId);
        ancestors.forEach((id) => next.add(id));
        return next;
      });
    }
  }, [selectedId, folders, autoExpandSelected]);

  const toggleExpand = (folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const expandAll = () => {
    const allIds = new Set<string>();
    for (const f of folders) {
      if ((f.folderCount ?? 0) > 0 || folders.some((child) => child.parentId === f.id)) {
        allIds.add(f.id);
      }
    }
    setExpandedIds(allIds);
  };

  const collapseAll = () => {
    setExpandedIds(new Set());
  };

  const renderTreeNode = (node: FolderTreeNode) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.id);
    const isSelected = selectedId === node.id;
    const isDisabled = disabledId === node.id;

    return (
      <div key={node.id} className="tree-branch" role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined}>
        <div
          className={`tree-node-row ${isSelected ? "is-selected" : ""} ${isDisabled ? "is-disabled" : ""}`}
          style={{ paddingLeft: `${10 + node.depth * 20}px` }}
          onClick={() => {
            if (!isDisabled) {
              onSelect(node.id);
            }
          }}
          onDoubleClick={() => {
            if (hasChildren) {
              toggleExpand(node.id);
            }
          }}
          title={node.name}
        >
          {hasChildren ? (
            <button
              type="button"
              className="tree-chevron-btn"
              aria-label={isExpanded ? `Thu gọn ${node.name}` : `Mở rộng ${node.name}`}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(node.id);
              }}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <span className="tree-chevron-spacer" aria-hidden="true" />
          )}

          <span className="tree-folder-icon" aria-hidden="true">
            {isExpanded ? <FolderOpen size={17} /> : <Folder size={17} />}
          </span>

          <span className="tree-node-text">{node.name}</span>

          {typeof node.fileCount === "number" && node.fileCount > 0 && (
            <span className="tree-node-count" title={`${node.fileCount} tài liệu`}>
              {node.fileCount}
            </span>
          )}
        </div>

        {hasChildren && isExpanded && (
          <div className="tree-children" role="group">
            {node.children.map(renderTreeNode)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`explorer-tree-view ${className}`} role="tree">
      {includeRoot && (
        <div
          className={`tree-node-row root-node ${selectedId === null ? "is-selected" : ""}`}
          style={{ paddingLeft: "10px" }}
          onClick={() => onSelect(null)}
          title={rootLabel}
          role="treeitem"
        >
          <span className="tree-chevron-spacer" aria-hidden="true" />
          <span className="tree-folder-icon root-icon" aria-hidden="true">
            <Home size={17} />
          </span>
          <span className="tree-node-text">{rootLabel}</span>
        </div>
      )}

      {tree.length === 0 ? (
        <div className="tree-empty-note">Chưa có thư mục nào</div>
      ) : (
        <div className="tree-body">{tree.map(renderTreeNode)}</div>
      )}
    </div>
  );
}

