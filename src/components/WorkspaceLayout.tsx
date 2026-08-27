import type { ReactNode } from "react";

export function WorkspaceLayout({ primary, detail }: { primary: ReactNode; detail?: ReactNode }) {
  const detailOpen = detail !== undefined && detail !== null;

  return (
    <section
      className="workspace-layout"
      data-detail-open={detailOpen}
      aria-label="Conversation workspace"
    >
      <div className="workspace-primary" data-workspace-region="primary">
        {primary}
      </div>
      {detailOpen ? (
        <div className="workspace-detail" data-workspace-region="detail">
          {detail}
        </div>
      ) : null}
    </section>
  );
}
