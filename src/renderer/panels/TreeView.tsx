import { useFileTreeStore } from '../store/fileTreeStore'
import { TreeNodeItem } from './TreeNodeItem'

export function TreeView() {
  const projects = useFileTreeStore((s) => s.projects)

  return (
    <div className="flex-1 overflow-y-auto">
      {projects.map((project) => (
        <div key={project.id} className="mb-1">
          {project.loading && (
            <div className="px-3 py-1 text-xs text-muted-foreground animate-pulse">
              Loading {project.name}...
            </div>
          )}
          {project.root && (
            <TreeNodeItem node={project.root} depth={0} />
          )}
        </div>
      ))}
    </div>
  )
}
