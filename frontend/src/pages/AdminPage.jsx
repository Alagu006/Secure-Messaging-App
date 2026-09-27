import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../App";
import { getApiUrl } from "../utils/serverConfig";

export default function AdminPage() {
  const { auth } = useAuth();
  const nav = useNavigate();
  const [users, setUsers] = useState([]);
  const [isAdmin, setIsAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});
  const [error, setError] = useState("");

  const API = getApiUrl();

  useEffect(() => {
    if (!auth.jwt) {
      nav("/login");
      return;
    }

    // Verify admin access and fetch user directory
    const checkAdminAndFetch = async () => {
      try {
        const adminRes = await fetch(`${API}/auth/is-admin`, {
          headers: { Authorization: `Bearer ${auth.jwt}` },
        });
        if (!adminRes.ok) throw new Error("Failed to verify admin status");
        const adminData = await adminRes.json();
        if (!adminData.is_admin) {
          setIsAdmin(false);
          setLoading(false);
          return;
        }
        setIsAdmin(true);

        const usersRes = await fetch(`${API}/auth/admin/users`, {
          headers: { Authorization: `Bearer ${auth.jwt}` },
        });
        if (!usersRes.ok) throw new Error("Failed to fetch user list");
        const usersData = await usersRes.json();
        setUsers(usersData);
      } catch (err) {
        setError(err.message || "Failed to load admin data");
      } finally {
        setLoading(false);
      }
    };

    checkAdminAndFetch();
  }, [auth.jwt, nav, API]);

  const toggleUserStatus = async (user) => {
    const isEnabling = !user.is_active;
    const endpoint = isEnabling ? "enable" : "disable";
    setActionLoading((prev) => ({ ...prev, [user.id]: true }));
    setError("");

    try {
      const res = await fetch(`${API}/auth/users/${user.id}/${endpoint}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${auth.jwt}` },
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || `Failed to ${endpoint} user`);
      }
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, is_active: isEnabling } : u))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading((prev) => ({ ...prev, [user.id]: false }));
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">Checking permissions...</div>
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-8 rounded-2xl shadow-lg max-w-md text-center">
          <h2 className="text-xl font-bold text-red-600 mb-2">Access Denied</h2>
          <p className="text-gray-600 mb-6">You do not have administrative privileges to view this page.</p>
          <button
            onClick={() => nav("/chat")}
            className="bg-whatsapp-green text-white px-6 py-2 rounded-lg hover:bg-whatsapp-green-dark transition"
          >
            Back to Chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-5xl mx-auto bg-white rounded-2xl shadow-md p-6">
        <div className="flex items-center justify-between mb-6 pb-4 border-b">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Admin Panel</h1>
            <p className="text-sm text-gray-500">Manage user accounts and employee access</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => nav("/settings")}
              className="px-4 py-2 border rounded-lg hover:bg-gray-50 transition text-sm font-medium text-gray-700"
            >
              Settings
            </button>
            <button
              onClick={() => nav("/chat")}
              className="px-4 py-2 bg-whatsapp-green text-white rounded-lg hover:bg-whatsapp-green-dark transition text-sm font-medium"
            >
              Back to Chat
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 border border-red-200 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b bg-gray-50 text-xs font-semibold text-gray-500 uppercase">
                <th className="py-3 px-4">User</th>
                <th className="py-3 px-4">User ID</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4">Last Seen</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y text-sm">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition">
                  <td className="py-3 px-4 font-medium text-gray-900">{u.username}</td>
                  <td className="py-3 px-4 font-mono text-xs text-gray-500">{u.id}</td>
                  <td className="py-3 px-4">
                    <span
                      className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                        u.is_active
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {u.is_active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs text-gray-500">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="py-3 px-4 text-xs text-gray-500">
                    {u.last_seen ? new Date(u.last_seen).toLocaleString() : "Never"}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => toggleUserStatus(u)}
                      disabled={actionLoading[u.id]}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                        u.is_active
                          ? "bg-red-50 text-red-600 hover:bg-red-100 border border-red-200"
                          : "bg-green-50 text-green-700 hover:bg-green-100 border border-green-200"
                      } disabled:opacity-50`}
                    >
                      {actionLoading[u.id]
                        ? "..."
                        : u.is_active
                        ? "Disable Account"
                        : "Enable Account"}
                    </button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-gray-400">
                    No registered users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
