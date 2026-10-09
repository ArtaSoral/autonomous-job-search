"use client";
import { useState } from "react";
type Contact = { name: string; email?: string; note?: string };
export default function ContactsEditor({ initial }: { initial: Contact[] }) {
  const [contacts, setContacts] = useState(initial);
  return (
    <>
      <input type="hidden" name="contacts" value={JSON.stringify(contacts)} />
      {contacts.map((contact, index) => (
        <div className="row" key={index}>
          <input
            aria-label="Contact name"
            placeholder="Name"
            value={contact.name}
            onChange={(e) =>
              setContacts(
                contacts.map((c, n) =>
                  n === index ? { ...c, name: e.target.value } : c,
                ),
              )
            }
          />
          <input
            aria-label="Contact email"
            placeholder="Email"
            type="email"
            value={contact.email || ""}
            onChange={(e) =>
              setContacts(
                contacts.map((c, n) =>
                  n === index ? { ...c, email: e.target.value } : c,
                ),
              )
            }
          />
          <input
            aria-label="Contact note"
            placeholder="Note"
            value={contact.note || ""}
            onChange={(e) =>
              setContacts(
                contacts.map((c, n) =>
                  n === index ? { ...c, note: e.target.value } : c,
                ),
              )
            }
          />
          <button
            type="button"
            onClick={() => setContacts(contacts.filter((_, n) => n !== index))}
          >
            Remove contact
          </button>
        </div>
      ))}
      <button
        type="button"
        style={{ marginTop: 10 }}
        onClick={() => setContacts([...contacts, { name: "" }])}
      >
        Add contact
      </button>
    </>
  );
}
