import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceLayout } from "@/components/WorkspaceLayout";

describe("WorkspaceLayout", () => {
  it("renders only the primary region without detail", () => {
    const { container } = render(<WorkspaceLayout primary={<p>Channel</p>} />);
    expect(screen.getByText("Channel")).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute("data-detail-open", "false");
    expect(container.querySelector("[data-workspace-region='detail']")).toBeNull();
  });

  it("replaces the primary region with detail", async () => {
    const close = vi.fn();
    const { container } = render(
      <WorkspaceLayout
        primary={<p>Channel</p>}
        detail={
          <button type="button" onClick={close}>
            Back to channel
          </button>
        }
      />,
    );
    expect(container.firstChild).toHaveAttribute("data-detail-open", "true");
    expect(container.querySelector("[data-workspace-region='primary']")).toBeNull();
    expect(container.querySelector("[data-workspace-region='detail']")).toBeInTheDocument();
    expect(screen.queryByText("Channel")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to channel" }));
    expect(close).toHaveBeenCalledOnce();
  });
});
