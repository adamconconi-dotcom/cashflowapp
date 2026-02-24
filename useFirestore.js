import { useEffect, useCallback } from "react";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase.js";

// Each user gets a single document: users/{uid}
// Fields: budgets, categoryOverrides, datasets[]
// datasets stores named uploads: { name, uploadedAt, transactions[] }

function userRef(uid) {
  return doc(db, "users", uid);
}

/**
 * Load the full user document from Firestore.
 * Returns { budgets, categoryOverrides, datasets } or defaults.
 */
export async function loadUserData(uid) {
  try {
    const snap = await getDoc(userRef(uid));
    if (snap.exists()) {
      const data = snap.data();
      return {
        budgets: data.budgets || {},
        categoryOverrides: data.categoryOverrides || {},
        datasets: (data.datasets || []).map(ds => ({
          ...ds,
          transactions: (ds.transactions || []).map(t => ({
            ...t,
            date: t.date?.toDate ? t.date.toDate() : new Date(t.date),
          })),
        })),
      };
    }
  } catch (err) {
    console.error("Firestore load error:", err);
  }
  return { budgets: {}, categoryOverrides: {}, datasets: [] };
}

/**
 * Save budgets to Firestore.
 */
export async function saveBudgets(uid, budgets) {
  try {
    await setDoc(userRef(uid), { budgets }, { merge: true });
  } catch (err) {
    console.error("Firestore save budgets error:", err);
  }
}

/**
 * Save category overrides to Firestore.
 */
export async function saveCategoryOverrides(uid, categoryOverrides) {
  try {
    await setDoc(userRef(uid), { categoryOverrides }, { merge: true });
  } catch (err) {
    console.error("Firestore save overrides error:", err);
  }
}

/**
 * Save a dataset (named set of transactions) to Firestore.
 * Transactions are stored as plain objects with ISO date strings.
 */
export async function saveDataset(uid, datasetName, transactions) {
  try {
    const snap = await getDoc(userRef(uid));
    const existing = snap.exists() ? snap.data().datasets || [] : [];

    // Serialize transactions (Firestore can't store Date objects directly in arrays well)
    const serialized = transactions.map(t => ({
      id: t.id,
      date: t.date instanceof Date ? t.date.toISOString() : t.date,
      description: t.description,
      amount: t.amount,
      category: t.category,
    }));

    // Replace dataset with same name, or add new
    const idx = existing.findIndex(ds => ds.name === datasetName);
    const dataset = { name: datasetName, uploadedAt: new Date().toISOString(), transactions: serialized };

    if (idx >= 0) {
      existing[idx] = dataset;
    } else {
      existing.push(dataset);
    }

    await setDoc(userRef(uid), { datasets: existing }, { merge: true });
  } catch (err) {
    console.error("Firestore save dataset error:", err);
  }
}

/**
 * Delete a dataset by name.
 */
export async function deleteDataset(uid, datasetName) {
  try {
    const snap = await getDoc(userRef(uid));
    if (snap.exists()) {
      const datasets = (snap.data().datasets || []).filter(ds => ds.name !== datasetName);
      await setDoc(userRef(uid), { datasets }, { merge: true });
    }
  } catch (err) {
    console.error("Firestore delete dataset error:", err);
  }
}
