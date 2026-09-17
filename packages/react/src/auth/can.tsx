/**
 * Can — Renders UI conditionally on an access requirement.
 *
 * Use it to show or hide a piece of an interface, such as an edit button. It
 * never redirects and never needs a router, so it is safe inside any component.
 * Client checks are presentation only; the server remains authoritative.
 *
 * @packageDocumentation
 */

import { satisfiesAccess } from "@blendsdk/authz";
import type { AccessRequirement } from "@blendsdk/authz";
import type { ReactElement, ReactNode } from "react";
import { useAuthorization } from "./use-authorization.js";

/**
 * Props for {@link Can}.
 */
export interface CanProps {
    /** The roles and permissions the user must hold. */
    requirement: AccessRequirement;
    /** Content to render when the requirement is satisfied. */
    children: ReactNode;
    /** Content to render when the requirement is not satisfied. Defaults to nothing. */
    fallback?: ReactNode;
}

/**
 * Renders `children` when the current user satisfies the requirement, and
 * `fallback` otherwise.
 *
 * An anonymous user behaves like a denied one: the fallback (or nothing) is
 * rendered and no redirect happens. The component does not require a router
 * context.
 *
 * @param props - The requirement, children, and optional fallback
 * @returns The children, the fallback, or `null`
 *
 * @example
 * ```tsx
 * <Can
 *     requirement={{ permissions: ["invoice:write"] }}
 *     fallback={<ReadOnlyNotice />}
 * >
 *     <EditInvoiceButton />
 * </Can>
 * ```
 */
export function Can(props: CanProps): ReactElement | null {
    const { roles, permissions } = useAuthorization();

    if (satisfiesAccess({ roles, permissions }, props.requirement)) {
        return <>{props.children}</>;
    }

    if (props.fallback === undefined || props.fallback === null) {
        return null;
    }
    return <>{props.fallback}</>;
}
