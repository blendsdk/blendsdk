// @vitest-environment jsdom

/**
 * useAuth hook test suite — UA-1, UA-2
 *
 * @see plans/react-auth/07-testing-strategy.md
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { GlobalLoaderProvider } from "../src/global-loader/index.js";
import { AuthProvider, useAuth, type AuthConfig } from "../src/auth/index.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useAuth", () => {
    // UA-1: Outside provider — throws
    it("UA-1: throws when called outside an AuthProvider", () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        function Orphan() {
            useAuth();
            return <div>should not render</div>;
        }

        expect(() => {
            render(<Orphan />);
        }).toThrow("must be used within an <AuthProvider>");

        consoleSpy.mockRestore();
    });

    // UA-2: Inside provider — returns context
    it("UA-2: returns context value when inside AuthProvider", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() =>
                Promise.resolve({
                    ok: false,
                    status: 401,
                    json: () => Promise.resolve({}),
                } as Response),
            ),
        );

        function Consumer() {
            const auth = useAuth();
            return (
                <div>
                    <span data-testid="has-login">
                        {String(typeof auth.login === "function")}
                    </span>
                    <span data-testid="has-logout">
                        {String(typeof auth.logout === "function")}
                    </span>
                    <span data-testid="has-refresh">
                        {String(typeof auth.refresh === "function")}
                    </span>
                    <span data-testid="has-user">
                        {String("user" in auth)}
                    </span>
                    <span data-testid="has-config">
                        {String("config" in auth)}
                    </span>
                </div>
            );
        }

        const config: AuthConfig = { basePath: "/api/auth" };

        render(
            <GlobalLoaderProvider>
                <AuthProvider config={config}>
                    <Consumer />
                </AuthProvider>
            </GlobalLoaderProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("has-login").textContent).toBe("true");
        });

        expect(screen.getByTestId("has-logout").textContent).toBe("true");
        expect(screen.getByTestId("has-refresh").textContent).toBe("true");
        expect(screen.getByTestId("has-user").textContent).toBe("true");
        expect(screen.getByTestId("has-config").textContent).toBe("true");

        vi.restoreAllMocks();
    });
});
