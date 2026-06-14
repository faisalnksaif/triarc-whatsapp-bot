import { useCallback, useEffect, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '../lib/supabase'
import type { QuestionnaireSet, Question } from '../types'

interface FormState {
  question: string
  question_en: string
  type: string
  options: string
  conditions: Record<string, string[]>
}

const EMPTY_FORM: FormState = {
  question: '',
  question_en: '',
  type: 'text',
  options: '',
  conditions: {},
}

export default function Questions() {
  const [sets, setSets] = useState<QuestionnaireSet[]>([])
  const [selectedSet, setSelectedSet] = useState<QuestionnaireSet | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [loadingSets, setLoadingSets] = useState(true)
  const [loadingQs, setLoadingQs] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM)
  const [addingNew, setAddingNew] = useState(false)
  const [newForm, setNewForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingTime, setEditingTime] = useState(false)
  const [timeForm, setTimeForm] = useState('')

  const listSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => {
    supabase
      .from('questionnaire_sets')
      .select('*')
      .order('schedule_time', { ascending: true })
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else { setSets(data as QuestionnaireSet[]); if (data?.length) setSelectedSet(data[0] as QuestionnaireSet) }
        setLoadingSets(false)
      })
  }, [])

  useEffect(() => {
    if (!selectedSet) return
    setLoadingQs(true)
    setEditingId(null)
    setAddingNew(false)
    supabase
      .from('questions')
      .select('*')
      .eq('set_id', selectedSet.id)
      .order('sort_order', { ascending: true })
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setQuestions(data as Question[])
        setLoadingQs(false)
      })
  }, [selectedSet])

  function startEdit(q: Question) {
    setEditingId(q.id)
    setAddingNew(false)
    setEditForm({
      question: q.question,
      question_en: q.question_en,
      type: q.type,
      options: q.options ? q.options.join('\n') : '',
      conditions: q.conditions ?? {},
    })
  }

  async function saveEdit(q: Question) {
    setSaving(true)
    setError(null)
    const options = editForm.type === 'poll'
      ? editForm.options.split('\n').map(s => s.trim()).filter(Boolean)
      : null
    const conditions = editForm.type === 'poll' && Object.keys(editForm.conditions).length > 0
      ? editForm.conditions
      : null
    const { error } = await supabase
      .from('questions')
      .update({ question: editForm.question, question_en: editForm.question_en, type: editForm.type, options, conditions })
      .eq('id', q.id)
    if (error) { setError(error.message); setSaving(false); return }
    setQuestions(prev => prev.map(x => x.id === q.id
      ? { ...x, question: editForm.question, question_en: editForm.question_en, type: editForm.type, options, conditions }
      : x
    ))
    setEditingId(null)
    setSaving(false)
  }

  async function deleteQuestion(q: Question) {
    if (!confirm(`Delete "${q.question_en}"?`)) return
    const { error } = await supabase.from('questions').delete().eq('id', q.id)
    if (error) { setError(error.message); return }
    setQuestions(prev => prev.filter(x => x.id !== q.id))
  }

  async function addQuestion() {
    if (!selectedSet) return
    setSaving(true)
    setError(null)
    const options = newForm.type === 'poll'
      ? newForm.options.split('\n').map(s => s.trim()).filter(Boolean)
      : null
    const conditions = newForm.type === 'poll' && Object.keys(newForm.conditions).length > 0
      ? newForm.conditions
      : null
    const maxOrder = questions.reduce((m, q) => Math.max(m, q.sort_order), 0)
    const question_id = `q_${Date.now()}`
    const { data, error } = await supabase
      .from('questions')
      .insert({
        set_id: selectedSet.id,
        question_id,
        question: newForm.question,
        question_en: newForm.question_en,
        type: newForm.type,
        options,
        conditions,
        sort_order: maxOrder + 1,
      })
      .select()
      .single()
    if (error) { setError(error.message); setSaving(false); return }
    setQuestions(prev => [...prev, data as Question])
    setNewForm(EMPTY_FORM)
    setAddingNew(false)
    setSaving(false)
  }

  async function saveTime() {
    if (!selectedSet || !timeForm) return
    setSaving(true)
    setError(null)
    const { error } = await supabase
      .from('questionnaire_sets')
      .update({ schedule_time: timeForm })
      .eq('id', selectedSet.id)
    if (error) { setError(error.message); setSaving(false); return }
    const updated = { ...selectedSet, schedule_time: timeForm }
    setSets(prev => prev.map(s => s.id === selectedSet.id ? updated : s))
    setSelectedSet(updated)
    setEditingTime(false)
    setSaving(false)
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = questions.findIndex(q => q.id === active.id)
    const newIdx = questions.findIndex(q => q.id === over.id)
    const reordered = arrayMove(questions, oldIdx, newIdx)
    setQuestions(reordered)
    setReordering(true)
    try {
      await Promise.all(reordered.map((q, i) =>
        supabase.from('questions').update({ sort_order: (i + 1) * 10 }).eq('id', q.id)
      ))
      setQuestions(prev => prev.map((q, i) => ({ ...q, sort_order: (i + 1) * 10 })))
    } catch {
      setError('Failed to save new order — please reload.')
    } finally {
      setReordering(false)
    }
  }

  if (loadingSets) return <div className="loading">Loading sets…</div>

  return (
    <div className="qs-layout">
      <aside className="qs-sidebar">
        <div className="qs-sidebar-title">Question Sets</div>
        {sets.map(s => (
          <button
            key={s.id}
            className={`qs-set-btn${selectedSet?.id === s.id ? ' active' : ''}`}
            onClick={() => setSelectedSet(s)}
          >
            <span className="qs-set-name">{s.title_en}</span>
            <span className="qs-set-ml">{s.title}</span>
            <span className="qs-set-time">{s.schedule_time}</span>
          </button>
        ))}
      </aside>

      <section className="qs-panel">
        {selectedSet && (
          <div className="qs-panel-header">
            <div>
              <h2 className="qs-panel-title">{selectedSet.title_en}</h2>
              <div className="qs-time-row">
                <span className="qs-panel-sub">{selectedSet.title}</span>
                {editingTime ? (
                  <>
                    <input type="time" className="qs-time-input" value={timeForm} onChange={e => setTimeForm(e.target.value)} />
                    <button className="btn-save qs-time-btn" onClick={saveTime} disabled={saving}>{saving ? '…' : 'Save'}</button>
                    <button className="btn-cancel qs-time-btn" onClick={() => setEditingTime(false)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="qs-panel-time">⏰ {selectedSet.schedule_time}</span>
                    <button className="btn-edit qs-time-btn" onClick={() => { setTimeForm(selectedSet.schedule_time); setEditingTime(true) }}>Change time</button>
                  </>
                )}
              </div>
            </div>
            <div className="qs-panel-actions">
              {reordering && <span className="qs-reorder-saving">Saving order…</span>}
              <button className="btn-add" onClick={() => { setAddingNew(true); setEditingId(null) }}>+ Add Question</button>
            </div>
          </div>
        )}

        {error && <div className="qs-error">{error}</div>}

        {loadingQs ? <div className="loading">Loading questions…</div> : (
          <div className="qs-list">
            <DndContext sensors={listSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={questions.map(q => q.id)} strategy={verticalListSortingStrategy}>
                {questions.map((q, idx) => (
                  <SortableRow
                    key={q.id}
                    q={q}
                    idx={idx}
                    isEditing={editingId === q.id}
                    editForm={editForm}
                    setEditForm={setEditForm}
                    saving={saving}
                    allQuestions={questions}
                    onEdit={() => startEdit(q)}
                    onDelete={() => deleteQuestion(q)}
                    onSaveEdit={() => saveEdit(q)}
                    onCancelEdit={() => setEditingId(null)}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {addingNew && (
              <div className="qs-row editing">
                <div className="qs-edit-form">
                  <QuestionForm form={newForm} onChange={setNewForm} label={`Q${questions.length + 1} (new)`} allQuestions={questions} />
                  <div className="qs-edit-actions">
                    <button className="btn-save" onClick={addQuestion} disabled={saving}>{saving ? 'Saving…' : 'Add'}</button>
                    <button className="btn-cancel" onClick={() => setAddingNew(false)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {questions.length === 0 && !addingNew && (
              <div className="empty">No questions yet — click "Add Question" to get started.</div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Sortable row (question list) ──────────────────────────────────────────────

interface RowProps {
  q: Question; idx: number; isEditing: boolean
  editForm: FormState; setEditForm: (f: FormState) => void
  saving: boolean; allQuestions: Question[]
  onEdit: () => void; onDelete: () => void
  onSaveEdit: () => void; onCancelEdit: () => void
}

function SortableRow({ q, idx, isEditing, editForm, setEditForm, saving, allQuestions, onEdit, onDelete, onSaveEdit, onCancelEdit }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 100 : undefined,
    opacity: isDragging ? 0.6 : 1,
  }

  const branchCount = q.conditions
    ? Object.values(q.conditions).reduce((n, ids) => n + ids.length, 0)
    : 0

  return (
    <div ref={setNodeRef} style={style} className={`qs-row${isEditing ? ' editing' : ''}${isDragging ? ' dragging' : ''}`}>
      {isEditing ? (
        <div className="qs-edit-form">
          <QuestionForm form={editForm} onChange={setEditForm} label={`Q${idx + 1}`} allQuestions={allQuestions} editingQuestionId={q.question_id} />
          <div className="qs-edit-actions">
            <button className="btn-save" onClick={onSaveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="btn-cancel" onClick={onCancelEdit}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="qs-drag-handle" {...attributes} {...listeners} title="Drag to reorder">⠿</div>
          <div className="qs-row-num">{idx + 1}</div>
          <div className="qs-row-body">
            <div className="qs-q-en">{q.question_en}</div>
            <div className="qs-q-ml">{q.question}</div>
            {q.options && (
              <div className="qs-options">
                {q.options.map(o => <span key={o} className="qs-option">{o}</span>)}
              </div>
            )}
            {branchCount > 0 && (
              <div className="qs-conditions">
                {Object.entries(q.conditions!).map(([opt, ids]) =>
                  ids.length > 0 && (
                    <span key={opt} className="qs-condition-tag">
                      "{opt}" → {ids.length} question{ids.length !== 1 ? 's' : ''}
                    </span>
                  )
                )}
              </div>
            )}
          </div>
          <div className="qs-row-type">
            <span className={`type-badge type-${q.type}`}>{q.type}</span>
          </div>
          <div className="qs-row-actions">
            <button className="btn-edit" onClick={onEdit}>Edit</button>
            <button className="btn-delete" onClick={onDelete}>Delete</button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Question form ─────────────────────────────────────────────────────────────

interface FormProps {
  form: FormState; onChange: (f: FormState) => void
  label: string; allQuestions?: Question[]; editingQuestionId?: string
}

function QuestionForm({ form, onChange, label, allQuestions = [], editingQuestionId }: FormProps) {
  const parsedOptions = form.type === 'poll'
    ? form.options.split('\n').map(s => s.trim()).filter(Boolean)
    : []
  const branchTargets = allQuestions.filter(q => q.question_id !== editingQuestionId)

  return (
    <div className="qf-wrap">
      <div className="qf-label">{label}</div>
      <div className="qf-row">
        <label>English</label>
        <input value={form.question_en} onChange={e => onChange({ ...form, question_en: e.target.value })} placeholder="Question in English" />
      </div>
      <div className="qf-row">
        <label>Malayalam</label>
        <input value={form.question} onChange={e => onChange({ ...form, question: e.target.value })} placeholder="Question in Malayalam" />
      </div>
      <div className="qf-row">
        <label>Type</label>
        <select value={form.type} onChange={e => onChange({ ...form, type: e.target.value, conditions: {} })}>
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="poll">Poll</option>
        </select>
      </div>
      {form.type === 'poll' && (
        <div className="qf-row">
          <label>Options <span className="qf-hint">(one per line)</span></label>
          <textarea value={form.options} onChange={e => onChange({ ...form, options: e.target.value })} placeholder={"Yes\nNo\nN/A"} rows={4} />
        </div>
      )}
      {form.type === 'poll' && parsedOptions.length > 0 && branchTargets.length > 0 && (
        <BranchEditor
          options={parsedOptions}
          allQuestions={branchTargets}
          value={form.conditions}
          onChange={conditions => onChange({ ...form, conditions })}
        />
      )}
    </div>
  )
}

// ── Branch editor (DnD) ───────────────────────────────────────────────────────

interface BranchEditorProps {
  options: string[]
  allQuestions: Question[]
  value: Record<string, string[]>
  onChange: (v: Record<string, string[]>) => void
}

function BranchEditor({ options, allQuestions, value, onChange }: BranchEditorProps) {
  const initContainers = useCallback((): Record<string, string[]> => {
    const branchedSet = new Set(Object.values(value).flat())
    const result: Record<string, string[]> = {
      pool: allQuestions.filter(q => !branchedSet.has(q.question_id)).map(q => q.question_id),
    }
    for (const opt of options) result[`opt:${opt}`] = value[opt] ?? []
    return result
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const [containers, setContainers] = useState<Record<string, string[]>>(initContainers)
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const findContainer = (itemId: string): string | null => {
    for (const [key, items] of Object.entries(containers)) {
      if (items.includes(itemId)) return key
    }
    return null
  }

  function commit(next: Record<string, string[]>) {
    setContainers(next)
    const newConditions: Record<string, string[]> = {}
    for (const opt of options) {
      const ids = next[`opt:${opt}`] ?? []
      if (ids.length > 0) newConditions[opt] = ids
    }
    onChange(newConditions)
  }

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string)
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null)
    if (!over) return

    const dragId = active.id as string
    const overId = over.id as string
    const src = findContainer(dragId)
    if (!src) return

    const dst = (overId in containers) ? overId : findContainer(overId)
    if (!dst) return

    if (src === dst) {
      const items = containers[src]
      const oldIdx = items.indexOf(dragId)
      const newIdx = items.indexOf(overId)
      if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return
      commit({ ...containers, [src]: arrayMove(items, oldIdx, newIdx) })
    } else {
      const srcItems = containers[src].filter(id => id !== dragId)
      const dstItems = [...containers[dst]]
      const overIdx = dstItems.indexOf(overId)
      if (overIdx >= 0) dstItems.splice(overIdx, 0, dragId)
      else dstItems.push(dragId)
      commit({ ...containers, [src]: srcItems, [dst]: dstItems })
    }
  }

  const activeQ = activeId ? allQuestions.find(q => q.question_id === activeId) : null

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="branch-editor">
        <div className="branch-editor-head">
          <span className="branch-editor-title">🔀 Branch Logic</span>
          <span className="branch-editor-hint">Drag questions into an answer bucket — they only fire when that answer is chosen</span>
        </div>

        <div className="branch-zones">
          {options.map(opt => {
            const containerId = `opt:${opt}`
            const ids = containers[containerId] ?? []
            return (
              <BranchZone key={opt} opt={opt} containerId={containerId} ids={ids} allQuestions={allQuestions} />
            )
          })}
        </div>

        <div className="branch-pool-wrap">
          <div className="branch-pool-label">Question pool — drag from here into a branch above</div>
          <BranchPool ids={containers.pool} allQuestions={allQuestions} />
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeQ && <ChipOverlay q={activeQ} />}
      </DragOverlay>
    </DndContext>
  )
}

function BranchZone({ opt, containerId, ids, allQuestions }: {
  opt: string; containerId: string; ids: string[]; allQuestions: Question[]
}) {
  const { setNodeRef, isOver } = useDroppable({ id: containerId })
  return (
    <div className={`branch-zone${isOver && ids.length === 0 ? ' branch-zone--over' : ''}`}>
      <div className="branch-zone-header">
        <span className="branch-opt-pill">{opt}</span>
        <span className="branch-zone-label">→ then ask:</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`branch-zone-drop${ids.length === 0 ? ' branch-zone-empty' : ''}${isOver ? ' branch-zone-drop--over' : ''}`}
        >
          {ids.length === 0
            ? <span className="branch-drop-hint">Drop questions here</span>
            : ids.map(id => {
                const q = allQuestions.find(x => x.question_id === id)
                return q ? <SortableChip key={id} q={q} /> : null
              })
          }
        </div>
      </SortableContext>
    </div>
  )
}

function BranchPool({ ids, allQuestions }: { ids: string[]; allQuestions: Question[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'pool' })
  return (
    <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
      <div ref={setNodeRef} className={`branch-pool${isOver ? ' branch-pool--over' : ''}${ids.length === 0 ? ' branch-pool-empty-state' : ''}`}>
        {ids.length === 0
          ? <span className="branch-pool-none">All questions are assigned to branches</span>
          : ids.map(id => {
              const q = allQuestions.find(x => x.question_id === id)
              return q ? <SortableChip key={id} q={q} /> : null
            })
        }
      </div>
    </SortableContext>
  )
}

function SortableChip({ q }: { q: Question }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: q.question_id })
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0 : 1 }
  return (
    <div ref={setNodeRef} style={style} className="branch-chip" {...attributes} {...listeners}>
      <span className="branch-chip-drag">⠿</span>
      <span className="branch-chip-text">{q.question_en}</span>
      <span className={`branch-chip-type type-${q.type}`}>{q.type}</span>
    </div>
  )
}

function ChipOverlay({ q }: { q: Question }) {
  return (
    <div className="branch-chip branch-chip--overlay">
      <span className="branch-chip-drag">⠿</span>
      <span className="branch-chip-text">{q.question_en}</span>
      <span className={`branch-chip-type type-${q.type}`}>{q.type}</span>
    </div>
  )
}
