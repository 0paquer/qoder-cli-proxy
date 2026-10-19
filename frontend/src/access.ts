import type { Me } from '@/services/qoderproxy';

/**
 * @see https://umijs.org/docs/max/access#access
 * */
export default function access(initialState: { currentUser?: Me } | undefined) {
  const { currentUser } = initialState ?? {};
  const role = currentUser?.user?.role ?? currentUser?.role;
  return {
    canAdmin: role === 'admin',
  };
}
